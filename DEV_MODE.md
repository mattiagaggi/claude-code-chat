# 🛠️ Dev Mode - Self-Modifying Extension

## Overview

**Dev Mode** is a meta feature that allows Claude Code to modify its own source code, compile the changes, and reload the extension - all from within the chat interface. This enables rapid iteration and self-improvement of the extension itself.

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User clicks 🛠️ Dev Mode                  │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  DevModeManager.enableDevMode()                             │
│  • Creates snapshot of current code                         │
│  • Creates canary git branch (dev-mode-canary-{timestamp}) │
│  • Starts watching src/ files for changes                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Extension source code is added to Claude's context         │
│  • All src/**/*.ts files are accessible                     │
│  • package.json included                                    │
│  • File structure mapped                                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  User: "Add a new feature X"                                │
│  Claude: *modifies src/ files using Edit/Write tools*       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  FileSystemWatcher detects changes                          │
│  • Debounces for 1 second (wait for all edits)             │
│  • Triggers compilation                                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Auto-compile                                               │
│  • Runs: npm run compile                                    │
│  • Success: Proceed to reload                               │
│  • Failure: Show error, don't reload                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Auto-commit (optional)                                     │
│  • Commits changes to canary branch                         │
│  • Message: "Dev Mode auto-commit: {timestamp}"            │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  User prompt: "Extension code updated! Reload?"             │
│  • Reload Now → restartExtensionHost                        │
│  • Reload Later → Continue working, reload when ready       │
└─────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Extension reloads with new code                            │
│  • Conversation state preserved (auto-saves before reload)  │
│  • New features immediately available                       │
└─────────────────────────────────────────────────────────────┘
```

## Safety Features

### 1. **Snapshot System**
- Before enabling Dev Mode, creates a snapshot of all source files
- Snapshots include: timestamp, git branch, commit hash, file contents
- Multiple snapshots maintained for history
- One-click rollback to any snapshot

### 2. **Canary Branches**
- Each Dev Mode session creates a new git branch: `dev-mode-canary-{timestamp}`
- All changes are isolated from main branch
- Easy to review changes with `git diff main`
- Can be merged or discarded after testing

### 3. **User-Controlled Reload**
- **No forced reloads** - user always has control
- "Reload Now" - applies changes immediately
- "Reload Later" - continues working, can reload anytime
- Preserves conversation state before reload

### 4. **Compilation Validation**
- TypeScript compilation must succeed before reload
- Syntax errors caught before deployment
- Detailed error output in "Dev Mode" output channel

### 5. **Rollback Capability**
```typescript
devModeManager.disableDevMode(true); // rollback = true
```
- Restores all files to snapshot state
- Recompiles with original code
- Returns to stable state

## Usage

### Enable Dev Mode

1. **Click 🛠️ Dev Mode button** in chat header
2. Button turns blue to indicate active state
3. See confirmation: "🛠️ Dev Mode enabled!"

### Make Changes

Now you can ask Claude to modify the extension:

**Example requests:**
```
"Add a new button to export conversations to PDF"
"Improve the graph visualization with better colors"
"Add keyboard shortcut Cmd+K to open a quick command palette"
"Refactor the message handler to use async/await"
"Add dark mode toggle to settings"
```

Claude will:
1. Read the relevant source files
2. Make the necessary changes
3. Update multiple files if needed
4. Wait for your approval to reload

### Review Changes

```bash
# See what Dev Mode changed
git diff main

# View canary branch
git branch | grep dev-mode-canary

# See commit history
git log --oneline dev-mode-canary-XXX
```

### Apply Changes

When prompted:
- **Reload Now** - Immediate effect
- **Reload Later** - Keeps working, reload when convenient

### Rollback

If something breaks:
1. Click 🛠️ Dev Mode to disable
2. Choose "Rollback" when prompted
3. Extension returns to previous state

## Configuration

### DevModeManager Options

```typescript
// In extension.ts
const devModeManager = new DevModeManager(context.extensionPath);

// Set callback to save state before reload
devModeManager.setReloadCallback(async () => {
    await conversationManager.saveConversation();
    // Save any other state
});

// Get snapshots
const snapshots = devModeManager.getSnapshots();

// Check if active
if (devModeManager.isActive()) {
    // Dev Mode specific logic
}
```

### File Watching

Automatically watches:
- `src/**/*.ts` - TypeScript files
- `src/**/*.js` - JavaScript files
- `src/**/*.json` - JSON config files

Excludes:
- `node_modules/`
- `out/`
- `.git/`

### Debounce Time

Changes are debounced by **1 second** to allow multiple edits before compilation.

```typescript
// In DevModeManager.ts
private compileTimeout = setTimeout(() => {
    this.compileAndReload();
}, 1000); // 1 second debounce
```

## Advanced Usage

### Context Customization

The `getSourceCodeContext()` method provides Claude with access to source files:

```typescript
// Add more files to context
const keyFiles = [
    'src/extension.ts',
    'src/ui.ts',
    'package.json',
    // Add your critical files here
];
```

### Custom Reload Logic

```typescript
devModeManager.setReloadCallback(async () => {
    // Save UI state
    await saveUIState();

    // Save open tabs
    const openEditors = vscode.window.visibleTextEditors;
    await saveOpenEditors(openEditors);

    // Any other state preservation
});
```

### Canary Branch Workflow

```bash
# After testing changes in Dev Mode

# Merge to main
git checkout main
git merge dev-mode-canary-1234567890

# Or create a PR
gh pr create --base main --head dev-mode-canary-1234567890 \
    --title "Dev Mode changes" \
    --body "Self-modification session"

# Clean up old canary branches
git branch | grep dev-mode-canary | xargs git branch -D
```

## Output Channel

View detailed logs:
1. Open **View → Output**
2. Select **"Dev Mode"** from dropdown
3. See real-time logging:
   - File changes detected
   - Compilation progress
   - Reload events
   - Error messages

## Best Practices

### 1. **Start Small**
Test Dev Mode with small changes first (like adding a button) before larger refactors.

### 2. **Review Before Reload**
Use `git diff` to review changes before reloading.

### 3. **Test in Canary**
Leave changes in canary branch until fully tested.

### 4. **Keep Snapshots**
Don't disable Dev Mode until you're sure changes work.

### 5. **One Feature at a Time**
Make focused changes rather than multiple features simultaneously.

## Troubleshooting

### Extension Won't Reload

**Problem:** Clicking "Reload Now" does nothing

**Solution:**
- Try manually: `Cmd/Ctrl + Shift + P` → "Developer: Reload Window"
- Check "Dev Mode" output channel for errors

### Compilation Fails

**Problem:** TypeScript errors prevent reload

**Solution:**
- Check "Dev Mode" output for error details
- Use `npm run compile` manually to see full errors
- Rollback if needed: Disable Dev Mode with rollback

### Changes Don't Appear

**Problem:** Reloaded but changes not visible

**Solution:**
- Check if files actually changed: `git diff`
- Verify compilation succeeded
- Try full window reload: `workbench.action.reloadWindow`

### Lost Changes

**Problem:** Accidentally disabled Dev Mode

**Solution:**
- Check git history: `git log --all --oneline | grep dev-mode`
- Restore from canary branch: `git checkout dev-mode-canary-XXX -- src/`

## Security Considerations

**⚠️ Warning:** Dev Mode allows arbitrary code modification. Only use in trusted development environments.

**Not recommended for:**
- Production machines
- Shared workspaces
- Untrusted repositories
- When working with sensitive code

**Recommended for:**
- Local development
- Personal projects
- Experimental features
- Rapid prototyping

## Future Enhancements

Planned features:
- **Live Preview** - See changes without reload
- **Diff Viewer** - Visual before/after comparison
- **Test Runner Integration** - Auto-run tests before reload
- **Multiple Snapshots** - Name and manage snapshots
- **Undo/Redo** - Step through change history
- **Change Proposals** - Review before applying
- **Safety Checks** - Lint/format validation

## Contributing

To improve Dev Mode:
1. Use Dev Mode itself to modify DevModeManager.ts
2. Test changes thoroughly
3. Commit to canary branch
4. Create PR from canary branch

## Example Session

```
User: Enable Dev Mode