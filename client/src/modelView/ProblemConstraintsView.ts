/* --------------------------------------------------------------------------------------------
 * Copyright (c) Jan Dolejsi. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
    Uri,
    ExtensionContext, TextDocument, CodeLens, CancellationToken, CodeLensProvider
} from 'vscode';

import { DomainInfo } from '../../../common/src/DomainInfo';
import { ProblemInfo } from '../../../common/src/ProblemInfo';

import * as path from 'path';
import { CodePddlWorkspace } from '../workspace/CodePddlWorkspace';
import { PddlTokenType } from '../../../common/src/PddlTokenizer';
import { nodeToRange } from '../utils';
import { DocumentInsetCodeLens, DocumentCodeLens } from './view';
import { ProblemView, ProblemRendererOptions, ProblemRenderer } from './ProblemView';
import { GraphViewData, NetworkEdge, NetworkNode } from './GraphViewData';
import { NamedConditionConstraint, AfterConstraint } from '../../../common/src/constraints';
import { ProblemViewPanel } from './ProblemViewPanel';

const CONTENT = path.join('views', 'modelView');

const PDDL_PROBLEM_CONSTRAINTS_PREVIEW_COMMAND = "pddl.problem.constraints.preview";
const PDDL_PROBLEM_CONSTRAINTS_INSET_COMMAND = "pddl.problem.constraints.inset";

export class ProblemConstraintsView extends ProblemView<ProblemConstraintsRendererOptions, GraphViewData> implements CodeLensProvider {

    constructor(context: ExtensionContext, codePddlWorkspace: CodePddlWorkspace) {
        super(context, codePddlWorkspace, new ProblemConstraintsRenderer(), {
            content: CONTENT,
            viewCommand: PDDL_PROBLEM_CONSTRAINTS_PREVIEW_COMMAND,
            insetViewCommand: PDDL_PROBLEM_CONSTRAINTS_INSET_COMMAND,
            insetHeight: 5,
            webviewType: 'problemConstraintsPreview',
            webviewHtmlPath: 'graphView.html',
            webviewOptions: {
                enableFindWidget: true,
                // enableCommandUris: true,
                retainContextWhenHidden: true,
                enableScripts: true,
                localResourceRoots: [
                    Uri.file(context.extensionPath)
                ]
            }
        },
            {}
        );
    }

    async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        if (token.isCancellationRequested) { return null; }
        let problem = await this.parseProblem(document);
        if (token.isCancellationRequested) { return null; }
        if (!problem) { return []; }

        let defineNode = problem.syntaxTree.getDefineNodeOrThrow();
        let constraintsNode = defineNode.getFirstChild(PddlTokenType.OpenBracketOperator, /\s*:constraints/i);
        if (constraintsNode) {
            return [
                new DocumentCodeLens(document, nodeToRange(document, constraintsNode)),
                new DocumentInsetCodeLens(document, nodeToRange(document, constraintsNode), document.positionAt(constraintsNode.getStart()).line)
            ];
        }
        else {
            return [];
        }
    }

    async resolveCodeLens(codeLens: CodeLens, token: CancellationToken): Promise<CodeLens> {
        if (!(codeLens instanceof DocumentCodeLens)) {
            return null;
        }
        if (token.isCancellationRequested) { return null; }
        let [domain] = await this.getProblemAndDomain(codeLens.getDocument());
        if (!domain) { return null; }
        if (token.isCancellationRequested) { return null; }

        if (codeLens instanceof DocumentInsetCodeLens) {
            codeLens.command = { command: PDDL_PROBLEM_CONSTRAINTS_INSET_COMMAND, title: 'View inset', arguments: [codeLens.getDocument().uri, codeLens.getLine()] };
            return codeLens;
        }
        else {
            codeLens.command = { command: PDDL_PROBLEM_CONSTRAINTS_PREVIEW_COMMAND, title: 'View', arguments: [codeLens.getDocument().uri] };
            return codeLens;
        }
    }

    protected createPreviewPanelTitle(uri: Uri) {
        return `:constraints of '${path.basename(uri.fsPath)}'`;
    }

    protected async handleOnLoad(panel: ProblemViewPanel): Promise<boolean> {
        await panel.postMessage('setOptions', {
            "layout": {
                "hierarchical": {
                    "enabled": true,
                    "levelSeparation": 50,
                    "treeSpacing": 300,
                    "sortMethod": "directed"
                }
            },
        });
        return super.handleOnLoad(panel);
    }
}

class ProblemConstraintsRenderer implements ProblemRenderer<ProblemConstraintsRendererOptions, GraphViewData> {
    render(context: ExtensionContext, problem: ProblemInfo, domain: DomainInfo, options: ProblemConstraintsRendererOptions): GraphViewData {
        let renderer = new ProblemConstraintsRendererDelegate(context, domain, problem, options);

        return {
            nodes: renderer.getNodes(),
            relationships: renderer.getRelationships()
        };
    }
}

class NamedConditionNode {
    constructor(readonly id: number, readonly name: string, readonly definition: string) { }
}

class ProblemConstraintsRendererDelegate {
    private nodes: Map<string, NamedConditionNode> = new Map();
    private relationships: NetworkEdge[] = [];
    private namedConditionConstraints: NamedConditionConstraint[];
    private afterConstraints: AfterConstraint[];
    private namedStateNames = new Set<string>();
    private lastNodeIndex: number;

    constructor(_context: ExtensionContext, private domain: DomainInfo, private problem: ProblemInfo, _options: ProblemConstraintsRendererOptions) {
        const allConstraints = this.domain.getConstraints().concat(this.problem.getConstraints());

        this.namedConditionConstraints = allConstraints
            .filter(c => c instanceof NamedConditionConstraint)
            .map(c => c as NamedConditionConstraint);

        this.afterConstraints = allConstraints
            .filter(c => c instanceof AfterConstraint)
            .map(c => c as AfterConstraint);

        this.namedConditionConstraints
            .forEach((c, index) => this.addNamedCondition(c, index));

        this.lastNodeIndex = this.namedConditionConstraints.length;

        this.afterConstraints.forEach(ac => {
            let predecessorId = this.upsertGoal(ac.predecessor);
            let successorId = this.upsertGoal(ac.successor);
            this.addEdge(predecessorId, successorId);
        });
    }

    private addNamedCondition(namedCondition: NamedConditionConstraint, index: number): number {
        this.nodes.set(namedCondition.name!, new NamedConditionNode(index, namedCondition.name!, namedCondition.condition!.getText()));
        this.namedStateNames.add(namedCondition.name!);
        return index;
    }

    private upsertGoal(namedCondition: NamedConditionConstraint): number {
        if (namedCondition.name) {
            let detail = this.nodes.get(namedCondition.name!);
            if (detail) {
                return detail.id;
            }
            else {
                // this happens when the model is incomplete
                return this.addNamedCondition(namedCondition, this.lastNodeIndex++);
            }
        }
        else if (namedCondition.condition) {
            let index = this.lastNodeIndex++;
            let conditionText = namedCondition.condition!.getText();
            this.nodes.set(conditionText, new NamedConditionNode(index, '', conditionText));
            return index;
        }
        else {
            throw new Error('Unexpected constraint: ' + namedCondition.toString());
        }
    }

    private addEdge(predecessorId: number, successorId: number): void {
        this.relationships.push({ from: predecessorId, to: successorId, label: "after" });
    }

    getNodes(): NetworkNode[] {
        return [...this.nodes.values()].map(entry => this.toNode(entry));
    }

    private toNode(entry: NamedConditionNode): NetworkNode {
        let shape = "box";
        let label = [entry.name, entry.definition]
            .filter(element => element && element.length > 0)
            .join(': ');
        return { id: entry.id, label: label, shape: shape };
    }

    getRelationships(): NetworkEdge[] {
        return this.relationships;
    }
}

interface ProblemConstraintsRendererOptions extends ProblemRendererOptions {
}
