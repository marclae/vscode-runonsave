import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext): void {

	var extension = new RunOnSaveExtension(context);
	extension.showOutputMessage();

	vscode.workspace.onDidChangeConfiguration(() => {
		let disposeStatus = extension.showStatusMessage('Run On Save: Reloading config.');
		extension.loadConfig();
		disposeStatus.dispose();
	});

	vscode.commands.registerCommand('runonsave-extension.enableRunOnSave', () => {
		extension.isEnabled = true;
	});

	vscode.commands.registerCommand('runonsave-extension.disableRunOnSave', () => {
		extension.isEnabled = false;
	});

	vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
		extension.runCommands(document.uri);
	});

	vscode.workspace.onDidSaveNotebookDocument((document: vscode.NotebookDocument) => {
		extension.runCommands(document.uri);
	});
}

interface ICommand {
	match?: string;
	notMatch?: string;
	cmd: string;
	isAsync: boolean;
}

interface IConfig {
	shell: string;
	autoClearConsole: boolean;
	commands: Array<ICommand>;
}

class RunOnSaveExtension {
	private _outputChannel: vscode.OutputChannel;
	private _context: vscode.ExtensionContext;
	private _config: IConfig;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this._outputChannel = vscode.window.createOutputChannel('Run On Save');
		this._config = this.loadConfig();
	}

	/** Recursive call to run commands. */
	private _runCommands(
		commands: Array<ICommand>,
		documentUri: vscode.Uri
	): void {
		if (commands.length) {
			var cfg = commands.shift();

			if (cfg !== undefined) {
				this.showOutputMessage(`*** cmd start: ${cfg.cmd}`);

				var child = exec(cfg.cmd, this._getExecOption(documentUri));

				if (child.stdout !== null && child.stderr !== null) {
					child.stdout.on('data', data => this._outputChannel.append(data));
					child.stderr.on('data', data => this._outputChannel.append(data));
					child.on('error', (e) => {
						this.showOutputMessage(e.message);
					});
					child.on('exit', (e) => {
						// if sync
						if (cfg !== undefined && !cfg.isAsync) {
							this._runCommands(commands, documentUri);
						}
					});
				}

				// if async, go ahead and run next command
				if (cfg.isAsync) {
					this._runCommands(commands, documentUri);
				}
			}
		}
		else {
			// NOTE: This technically just marks the end of commands starting.
			// There could still be asyc commands running.
			this.showStatusMessage('Run on Save done.');
		}
	}

	private _getExecOption(
		documentUri: vscode.Uri
	): { shell: string, cwd: string } {
		return {
			shell: this.shell,
			cwd: String(this._getWorkspaceFolderPath(documentUri)),
		};
	}

	private _getWorkspaceFolderPath(
		uri: vscode.Uri
	) {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

		// NOTE: rootPath seems to be deprecated but seems like the best fallback so that
		// single project workspaces still work. If I come up with a better option, I'll change it.
		return workspaceFolder
			? workspaceFolder.uri.fsPath
			: vscode.workspace.rootPath;
	}

	public get isEnabled(): boolean {
		return !!this._context.globalState.get('isEnabled', true);
	}
	public set isEnabled(value: boolean) {
		this._context.globalState.update('isEnabled', value);
		this.showOutputMessage();
	}

	public get shell(): string {
		return this._config.shell;
	}

	public get autoClearConsole(): boolean {
		return !!this._config.autoClearConsole;
	}

	public get commands(): Array<ICommand> {
		return this._config.commands || [];
	}

	public loadConfig(): IConfig {
		return <IConfig><any>vscode.workspace.getConfiguration('emeraldwalk.runonsave');
	}

	/**
	 * Show message in output channel
	 */
	public showOutputMessage(message?: string): void {
		message = message || `Run On Save ${this.isEnabled ? 'enabled' : 'disabled'}.`;
		this._outputChannel.appendLine(message);
	}

	/**
	 * Show message in status bar and output channel.
	 * Return a disposable to remove status bar message.
	 */
	public showStatusMessage(message: string): vscode.Disposable {
		this.showOutputMessage(message);
		return vscode.window.setStatusBarMessage(message);
	}

	public runCommands(documentUri: vscode.Uri): void {
		this.showOutputMessage("Blub")
		const fileName = documentUri.fsPath;

		if (this.autoClearConsole) {
			this._outputChannel.clear();
		}

		if (!this.isEnabled || this.commands.length === 0) {
			this.showOutputMessage();
			return;
		}

		var match = (pattern: string) => pattern && pattern.length > 0 && new RegExp(pattern).test(fileName);

		var commandConfigs = this.commands
			.filter(cfg => {
				var matchPattern = cfg.match || '';
				var negatePattern = cfg.notMatch || '';

				// if no match pattern was provided, or if match pattern succeeds
				var isMatch = matchPattern.length === 0 || match(matchPattern);

				// negation has to be explicitly provided
				var isNegate = negatePattern.length > 0 && match(negatePattern);

				// negation wins over match
				return !isNegate && isMatch;
			});

		if (commandConfigs.length === 0) {
			return;
		}

		this.showStatusMessage('Running on save commands...');

		// build our commands by replacing parameters with values
		const commands: Array<ICommand> = [];
		for (const cfg of commandConfigs) {
			let cmdStr = cfg.cmd;

			const extName = path.extname(fileName);
			const workspaceFolderPath = String(this._getWorkspaceFolderPath(documentUri));
			const relativeFile = path.relative(
				workspaceFolderPath,
				documentUri.fsPath
			);

			cmdStr = cmdStr.replace(/\${file}/g, `${fileName}`);

			// DEPRECATED: workspaceFolder is more inline with vscode variables,
			// but leaving old version in place for any users already using it.
			cmdStr = cmdStr.replace(/\${workspaceRoot}/g, workspaceFolderPath);

			cmdStr = cmdStr.replace(/\${workspaceFolder}/g, workspaceFolderPath);
			cmdStr = cmdStr.replace(/\${fileBasename}/g, path.basename(fileName));
			cmdStr = cmdStr.replace(/\${fileDirname}/g, path.dirname(fileName));
			cmdStr = cmdStr.replace(/\${fileExtname}/g, extName);
			cmdStr = cmdStr.replace(/\${fileBasenameNoExt}/g, path.basename(fileName, extName));
			cmdStr = cmdStr.replace(/\${relativeFile}/g, relativeFile);
			cmdStr = cmdStr.replace(/\${cwd}/g, process.cwd());

			// replace environment variables ${env.Name}
			cmdStr = cmdStr.replace(/\${env\.([^}]+)}/g, (sub: string, envName: string) => {
				return String(process.env[envName]);
			});

			commands.push({
				cmd: cmdStr,
				isAsync: !!cfg.isAsync
			});
		}

		this._runCommands(commands, documentUri);
	}
}
