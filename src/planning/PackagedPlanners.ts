/*
 * Copyright (c) Jan Dolejsi 2022. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 */
'use strict';

import { URL } from 'url';
import { ProgressLocation, QuickPickItem, window } from 'vscode';
import { getJson2 } from '../httpUtils';

/** See https://github.com/AI-Planning/planning-as-a-service/issues/32 */
export class PackagedPlanners {
    constructor(private readonly packageUrl: string) {

    }

    async getManifests(): Promise<PackageManifest[]> {
        return window.withProgress<PackageManifest[]>({
            location: ProgressLocation.Notification,
            title: 'Discovering packages...',
            cancellable: true
        }, async () => await getJson2(new URL(this.packageUrl)));
    }

    async select(): Promise<SelectedEndpoint | undefined> {
        const manifests = await this.getManifests();
        const plannerItems = manifests.map(m => this.toManifestQuickPickItem(m));
        const selectedOption = await window.showQuickPick(plannerItems, {
            matchOnDescription: true, matchOnDetail: true, placeHolder: 'Select a planner...'
        });
        const selectedPackage = selectedOption?.manifest;
        if (!selectedPackage) { return; }
        const endpointCount = Object.keys(selectedPackage.endpoint.services).length;
        if (endpointCount > 1) {
            const serviceItems = Object.entries(selectedPackage.endpoint.services)
                .map(endpointService => this.toServiceQuickPickItem(selectedPackage, endpointService[0], endpointService[1]));
            const selectedServiceItem = await window.showQuickPick(serviceItems, {
                matchOnDescription: true, matchOnDetail: true, placeHolder: 'Select an endpoint...'
            });
            return selectedServiceItem;
        } else if (endpointCount === 1) {
            const firstEndpoint = Object.keys(selectedPackage.endpoint.services)[0];
            return {
                manifest: selectedPackage,
                endpoint: firstEndpoint,
                service: selectedPackage.endpoint.services[firstEndpoint],
            };
        } else {
            throw new Error(`There is no endpoint service defined for ${selectedPackage.name}`);
        }
    }

    private toManifestQuickPickItem(manifest: PackageManifest): PackageQuickPickItem {
        return {
            label: manifest.name,
            description: manifest.package_name,
            detail: manifest.description,
            manifest: manifest,
        };
    }

    private toServiceQuickPickItem(manifest: PackageManifest, endpoint: string, service: EndpointService): EndpointQuickPickItem {
        return {
            label: endpoint,
            description: service.call,
            detail: Object.keys(service.args).join(', '),
            manifest: manifest,
            endpoint: endpoint,
            service: service,
        };
    }
}

interface PackageQuickPickItem extends QuickPickItem {
    manifest: PackageManifest;
}

interface EndpointQuickPickItem extends QuickPickItem, SelectedEndpoint {
}

export interface SelectedEndpoint {
    manifest: PackageManifest;
    endpoint: string;
    service: EndpointService;
}

/** Describes returned data structure. */
interface PackageManifest {
    description: string | undefined;
    package_name: string | undefined;
    name: string;
    endpoint: {
        services: { [key: string]: EndpointService }
    };
    runnable: boolean;
    "install-size": string;
    dependencies: string[];
}

export interface EndpointService {
    args: EndpointServiceArgument[];
    call: string; // irrelevant for remote calling
    return: {
        files: string,
        type: string
    }; // irrelevant for remote calling
}

export interface EndpointServiceArgument {
    name: "domain" | "problem" | string;
    description: string;
    type: "file" | "int" | "categorical";
    default?: string | number | boolean;
    /** Only if type is 'categorical' */
    choices?: EndpointServiceArgumentChoice[];
}

export interface EndpointServiceArgumentChoice {
    display_value: string;
    value: string | number | boolean;
}