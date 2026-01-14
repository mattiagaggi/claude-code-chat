/**
 * DevModeManager - Enables self-modification of the extension
 *
 * Allows Claude Code to modify its own source code, compile, and hot-reload
 * in a safe, controlled manner with rollback capabilities.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DevModeSnapshot {
    timestamp: number;
    branch: string;
    commitHash: string;
    files: Map<string, string>; // filepath -> content
}

export class DevModeManager {
    private isDevModeActive: boolean = false;
    private extensionPath: string;
    private sourceWatcher?: vscode.FileSystemWatcher;
    private compileTimeout?: NodeJS.Timeout;
    private snapshots: DevModeSnapshot[] = [];
    private currentCanaryBranch?: string;
    private outputChannel: vscode.OutputChannel;
    private reloadCallback?: () => Promise<void>;

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
        this.outputChannel = vscode.window.createOutputChannel('Dev Mode');
    }

    /**
     * Set callback to be called before reload (for saving state)
     */
    setReloadCallback(callback: () => Promise<void>): void {
        this.reloadCallback = callback;
    }

    /**
     * Enable Dev Mode - allows self-modification
     */
    async enableDevMode(): Promise<void> {
        if (this.isDevModeActive) {
            this.log('Dev Mode already active');
            return;
        }

        this.log('🛠️ Enabling Dev Mode...');

        // Create snapshot before enabling
        await this.createSnapshot();

        // Create canary branch
        await this.createCanaryBranch();

        // Start watching source files
        this.startSourceWatcher();

        this.isDevModeActive = true;
        this.log('✅ Dev Mode enabled - Extension is now self-modifiable!');

        vscode.window.showInformationMessage(
            '🛠️ Dev Mode enabled! Claude Code can now modify its own source code.',
            'View Docs'
        );
    }

    /**
     * Disable Dev Mode - stops self-modification
     */
    async disableDevMode(rollback: boolean = false): Promise<void> {
        if (!this.isDevModeActive) {
            return;
        }

        this.log('Disabling Dev Mode...');

        // Stop watching files
        this.stopSourceWatcher();

        if (rollback && this.snapshots.length > 0) {
            await this.rollbackToSnapshot(this.snapshots[this.snapshots.length - 1]);
        }

        this.isDevModeActive = false;
        this.log('✅ Dev Mode disabled');

        vscode.window.showInformationMessage('Dev Mode disabled');
    }

    /**
     * Check if Dev Mode is active
     */
    isActive(): boolean {
        return this.isDevModeActive;
    }

    /**
     * Get extension source code for context
     */
    async getSourceCodeContext(): Promise<string> {
        const srcPath = path.join(this.extensionPath, 'src');
        const files = await this.getAllSourceFiles(srcPath);

        let context = '# Extension Source Code\n\n';
        context += `Extension Path: ${this.extensionPath}\n\n`;
        context += '## File Structure:\n';

        for (const file of files) {
            const relativePath = path.relative(this.extensionPath, file);
            context += `- ${relativePath}\n`;
        }

        context += '\n## Key Files:\n\n';

        // Include important files in full
        const keyFiles = [
            'src/extension.ts',
            'src/ui.ts',
            'package.json'
        ];

        for (const keyFile of keyFiles) {
            const filePath = path.join(this.extensionPath, keyFile);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                context += `### ${keyFile}\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
            }
        }

        return context;
    }

    /**
     * Create a snapshot of current state
     */
    private async createSnapshot(): Promise<DevModeSnapshot> {
        this.log('Creating snapshot...');

        const snapshot: DevModeSnapshot = {
            timestamp: Date.now(),
            branch: await this.getCurrentBranch(),
            commitHash: await this.getCurrentCommit(),
            files: new Map()
        };

        // Save all source files
        const srcPath = path.join(this.extensionPath, 'src');
        const files = await this.getAllSourceFiles(srcPath);

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf8');
            const relativePath = path.relative(this.extensionPath, file);
            snapshot.files.set(relativePath, content);
        }

        this.snapshots.push(snapshot);
        this.log(`Snapshot created: ${snapshot.files.size} files`);

        return snapshot;
    }

    /**
     * Rollback to a previous snapshot
     */
    private async rollbackToSnapshot(snapshot: DevModeSnapshot): Promise<void> {
        this.log(`Rolling back to snapshot from ${new Date(snapshot.timestamp).toISOString()}...`);

        for (const [relativePath, content] of snapshot.files) {
            const filePath = path.join(this.extensionPath, relativePath);
            fs.writeFileSync(filePath, content, 'utf8');
        }

        // Recompile
        await this.compile();

        this.log('✅ Rollback complete');
        vscode.window.showInformationMessage('Rolled back to previous snapshot');
    }

    /**
     * Create a canary branch for testing changes
     */
    private async createCanaryBranch(): Promise<void> {
        const timestamp = Date.now();
        const branchName = `dev-mode-canary-${timestamp}`;

        try {
            await this.execGit(`checkout -b ${branchName}`);
            this.currentCanaryBranch = branchName;
            this.log(`Created canary branch: ${branchName}`);
        } catch (error) {
            this.log(`Warning: Could not create canary branch: ${error}`);
        }
    }

    /**
     * Start watching source files for changes
     */
    private startSourceWatcher(): void {
        const srcPattern = new vscode.RelativePattern(
            this.extensionPath,
            'src/**/*.{ts,js,json}'
        );

        this.sourceWatcher = vscode.workspace.createFileSystemWatcher(srcPattern);

        this.sourceWatcher.onDidChange(() => this.onSourceChanged());
        this.sourceWatcher.onDidCreate(() => this.onSourceChanged());
        this.sourceWatcher.onDidDelete(() => this.onSourceChanged());

        this.log('Started watching source files');
    }

    /**
     * Stop watching source files
     */
    private stopSourceWatcher(): void {
        if (this.sourceWatcher) {
            this.sourceWatcher.dispose();
            this.sourceWatcher = undefined;
            this.log('Stopped watching source files');
        }
    }

    /**
     * Handle source file changes
     */
    private onSourceChanged(): void {
        this.log('Source file changed, scheduling compilation...');

        // Debounce compilation
        if (this.compileTimeout) {
            clearTimeout(this.compileTimeout);
        }

        this.compileTimeout = setTimeout(() => {
            this.compileAndReload();
        }, 1000); // Wait 1 second after last change
    }

    /**
     * Compile and reload the extension
     */
    private async compileAndReload(): Promise<void> {
        this.log('🔨 Compiling extension...');

        try {
            await this.compile();
            this.log('✅ Compilation successful');

            // Auto-commit changes
            if (this.currentCanaryBranch) {
                await this.autoCommit();
            }

            // Ask user before reloading to prevent breaking UI
            const choice = await vscode.window.showInformationMessage(
                '🔄 Extension compiled successfully! Reload to apply changes?',
                'Reload Now',
                'Reload Later',
                'Test First'
            );

            if (choice === 'Reload Now') {
                await this.reloadExtension(true);
            } else if (choice === 'Test First') {
                vscode.window.showInformationMessage(
                    'Review changes with "git diff", then reload manually when ready.',
                    'Show Diff',
                    'Reload Now'
                ).then(async (diffChoice) => {
                    if (diffChoice === 'Show Diff') {
                        vscode.commands.executeCommand('git.openChange');
                    } else if (diffChoice === 'Reload Now') {
                        await this.reloadExtension(true);
                    }
                });
            }
            // If "Reload Later", do nothing - user can reload manually
        } catch (error) {
            this.log(`❌ Compilation failed: ${error}`);
            vscode.window.showErrorMessage(
                '❌ Extension compilation failed. Changes NOT applied.',
                'View Output',
                'Rollback'
            ).then(async (choice) => {
                if (choice === 'View Output') {
                    this.outputChannel.show();
                } else if (choice === 'Rollback') {
                    await this.disableDevMode(true);
                }
            });
        }
    }

    /**
     * Compile the extension
     */
    private async compile(): Promise<void> {
        // Build comprehensive PATH with common npm installation locations
        const homedir = process.env.HOME || process.env.USERPROFILE || '';
        const commonPaths = [
            process.env.PATH || '',
            '/usr/local/bin',
            '/opt/homebrew/bin',  // Homebrew on Apple Silicon
            '/usr/bin',
            '/bin',
            `${homedir}/.nvm/versions/node/*/bin`,
            `${homedir}/.npm-global/bin`,
            `${homedir}/.yarn/bin`,
            '/opt/homebrew/opt/node/bin'
        ].filter(Boolean).join(':');

        // Try to get shell PATH as additional fallback
        let fullPath = commonPaths;
        try {
            const shell = process.env.SHELL || '/bin/bash';
            const pathCommand = shell.includes('fish')
                ? `${shell} -c 'echo $PATH'`
                : `${shell} -l -c 'echo $PATH'`;
            const { stdout: pathOutput } = await execAsync(pathCommand, { timeout: 2000 });
            if (pathOutput.trim()) {
                fullPath = `${commonPaths}:${pathOutput.trim()}`;
            }
        } catch (e) {
            this.log(`Using fallback PATH (shell PATH unavailable)`);
        }

        this.log(`Running: npm run compile with PATH=${fullPath.substring(0, 100)}...`);
        const { stdout, stderr } = await execAsync('npm run compile', {
            cwd: this.extensionPath,
            env: { ...process.env, PATH: fullPath },
            shell: '/bin/bash'
        });

        if (stderr) {
            this.log(`Compile stderr: ${stderr}`);
        }
        if (stdout) {
            this.log(`Compile stdout: ${stdout}`);
        }
    }

    /**
     * Reload the extension (soft reload - preserves UI state)
     */
    private async reloadExtension(skipPrompt: boolean = false): Promise<void> {
        this.log('🔄 Soft reloading extension (preserving UI state)...');

        // Call the callback to save state before reload
        if (this.reloadCallback) {
            try {
                await this.reloadCallback();
                this.log('State saved before reload');
            } catch (error) {
                this.log(`Warning: Could not save state before reload: ${error}`);
            }
        }

        // Show user-friendly notification (unless already prompted)
        let shouldReload = skipPrompt;
        if (!skipPrompt) {
            const choice = await vscode.window.showInformationMessage(
                '🔄 Extension code updated! Reload to apply changes?',
                'Reload Now',
                'Reload Later'
            );
            shouldReload = choice === 'Reload Now';
        }

        if (shouldReload) {
            try {
                // Restart extension host (this reloads the extension but preserves workspace)
                await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
            } catch (error) {
                this.log(`Could not restart extension host: ${error}`);

                // Fallback: offer full reload
                const fullReload = await vscode.window.showWarningMessage(
                    'Could not restart extension. Try full window reload?',
                    'Reload Window',
                    'Cancel'
                );

                if (fullReload === 'Reload Window') {
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            }
        } else {
            this.log('User chose to reload later');
            vscode.window.showInformationMessage(
                '💡 Reload when ready to apply changes',
                'Reload Now'
            ).then(choice => {
                if (choice === 'Reload Now') {
                    vscode.commands.executeCommand('workbench.action.restartExtensionHost');
                }
            });
        }
    }

    /**
     * Auto-commit changes to canary branch
     */
    private async autoCommit(): Promise<void> {
        try {
            await this.execGit('add src/');
            await this.execGit(`commit -m "Dev Mode auto-commit: ${new Date().toISOString()}"`);
            this.log('Auto-committed changes to canary branch');
        } catch (error) {
            // Ignore commit errors (might be no changes)
            this.log(`Auto-commit note: ${error}`);
        }
    }

    /**
     * Get all source files recursively
     */
    private async getAllSourceFiles(dir: string): Promise<string[]> {
        const files: string[] = [];

        const items = fs.readdirSync(dir, { withFileTypes: true });

        for (const item of items) {
            const fullPath = path.join(dir, item.name);

            if (item.isDirectory()) {
                files.push(...await this.getAllSourceFiles(fullPath));
            } else if (item.isFile() && /\.(ts|js|json)$/.test(item.name)) {
                files.push(fullPath);
            }
        }

        return files;
    }

    /**
     * Execute git command
     */
    private async execGit(command: string): Promise<string> {
        const { stdout } = await execAsync(`git ${command}`, {
            cwd: this.extensionPath
        });
        return stdout.trim();
    }

    /**
     * Get current git branch
     */
    private async getCurrentBranch(): Promise<string> {
        try {
            return await this.execGit('rev-parse --abbrev-ref HEAD');
        } catch {
            return 'unknown';
        }
    }

    /**
     * Get current git commit hash
     */
    private async getCurrentCommit(): Promise<string> {
        try {
            return await this.execGit('rev-parse HEAD');
        } catch {
            return 'unknown';
        }
    }

    /**
     * Log to output channel
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    /**
     * Get list of snapshots
     */
    getSnapshots(): DevModeSnapshot[] {
        return [...this.snapshots];
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.stopSourceWatcher();
        if (this.compileTimeout) {
            clearTimeout(this.compileTimeout);
        }
        this.outputChannel.dispose();
    }
}
