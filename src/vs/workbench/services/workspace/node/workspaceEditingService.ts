/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IWindowService, IEnterWorkspaceResult } from 'vs/platform/windows/common/windows';
import { IJSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditing';
import { IWorkspaceIdentifier } from 'vs/platform/workspaces/common/workspaces';
import { IWorkspaceConfigurationService } from 'vs/workbench/services/configuration/common/configuration';
import { WorkspaceService } from 'vs/workbench/services/configuration/node/configurationService';
import { migrateStorageToMultiRootWorkspace } from 'vs/platform/storage/common/migration';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { StorageService } from 'vs/platform/storage/common/storageService';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { Registry } from 'vs/platform/registry/common/platform';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { BackupFileService } from 'vs/workbench/services/backup/node/backupFileService';

export class WorkspaceEditingService implements IWorkspaceEditingService {

	public _serviceBrand: any;

	constructor(
		@IJSONEditingService private jsonEditingService: IJSONEditingService,
		@IWorkspaceContextService private contextService: WorkspaceService,
		@IWindowService private windowService: IWindowService,
		@IWorkspaceConfigurationService private workspaceConfigurationService: IWorkspaceConfigurationService,
		@IStorageService private storageService: IStorageService,
		@IExtensionService private extensionService: IExtensionService,
		@IBackupFileService private backupFileService: IBackupFileService
	) {
	}

	public createAndEnterWorkspace(folderPaths?: string[], path?: string): TPromise<void> {
		return this.doEnterWorkspace(() => this.windowService.createAndEnterWorkspace(folderPaths, path));
	}

	public saveAndEnterWorkspace(path: string): TPromise<void> {
		return this.doEnterWorkspace(() => this.windowService.saveAndEnterWorkspace(path));
	}

	private doEnterWorkspace(mainSidePromise: () => TPromise<IEnterWorkspaceResult>): TPromise<void> {

		// Stop the extension host first to give extensions most time to shutdown
		this.extensionService.stopExtensionHost();

		return mainSidePromise().then(result => {
			let enterWorkspacePromise: TPromise<void> = TPromise.as(void 0);
			if (result) {

				// Migrate storage and settings
				enterWorkspacePromise = this.migrate(result.workspace).then(() => {

					// Reinitialize backup service
					const backupFileService = this.backupFileService as BackupFileService; // TODO@Ben ugly cast
					backupFileService.initialize(result.backupPath);

					// Reinitialize configuration service
					const workspaceImpl = this.contextService as WorkspaceService; // TODO@Ben TODO@Sandeep ugly cast
					return workspaceImpl.initialize(result.workspace);
				});
			}

			// Finally bring the extension host back online
			return enterWorkspacePromise.then(() => this.extensionService.startExtensionHost());
		});
	}

	private migrate(toWorkspace: IWorkspaceIdentifier): TPromise<void> {

		// Storage (UI State) migration
		this.migrateStorage(toWorkspace);

		// Settings migration (only if we come from a folder workspace)
		if (this.contextService.getWorkbenchState() === WorkbenchState.FOLDER) {
			return this.copyWorkspaceSettings(toWorkspace);
		}

		return TPromise.as(void 0);
	}

	private migrateStorage(toWorkspace: IWorkspaceIdentifier): void {

		// TODO@Ben revisit this when we move away from local storage to a file based approach
		const storageImpl = this.storageService as StorageService;
		const newWorkspaceId = migrateStorageToMultiRootWorkspace(storageImpl.workspaceId, toWorkspace, storageImpl.workspaceStorage);
		storageImpl.setWorkspaceId(newWorkspaceId);
	}

	public copyWorkspaceSettings(toWorkspace: IWorkspaceIdentifier): TPromise<void> {
		const configurationProperties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		const targetWorkspaceConfiguration = {};
		for (const key of this.workspaceConfigurationService.keys().workspace) {
			if (configurationProperties[key] && !configurationProperties[key].isFromExtensions && configurationProperties[key].scope === ConfigurationScope.WINDOW) {
				targetWorkspaceConfiguration[key] = this.workspaceConfigurationService.inspect(key).workspace;
			}
		}

		return this.jsonEditingService.write(URI.file(toWorkspace.configPath), { key: 'settings', value: targetWorkspaceConfiguration }, true);
	}
}
