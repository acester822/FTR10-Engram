Renaming hundreds of occurrences across a codebase can be daunting, but with Git and a few Linux command-line tools, you can do it safely, quickly, and reversibly. 

Since you are on Linux, here is the safest, most efficient step-by-step guide to rebranding everything to **Engram** (and updating prefixes like `OM_` to `EG_`).

---

### ⚠️ Phase 1: Safety First (Do Not Skip)
Before running any bulk operations, ensure you have a clean slate and a safe place to experiment.

1. **Commit or stash any current work:**
   ```bash
   git add .
   git commit -m "chore: save state before Engram rebrand"
   ```
2. **Create a new branch for the refactor:**
   ```bash
   git checkout -b refactor/rename-to-engram
   ```

---

### ⚠️ Phase 2: Rename Files and Directories
Text replacement won't rename the actual files or folders (like `packages/openmemory-js`). We need to rename those first.

Run this in the root of your repository. *(Note: This uses the Perl-based `rename` utility, which is standard on most Linux distros. If you get a "command not found" error, install it via `sudo apt install rename`).*

```bash
# Rename directories and files (case-insensitive matches handled separately)
echo "Renaming files and directories..."

# Lowercase openmemory -> engram
find . -depth -name '*openmemory*' -not -path '*/.git/*' -not -path '*/node_modules/*' -exec rename 's/openmemory/engram/g' {} +

# Capitalized OpenMemory -> Engram
find . -depth -name '*OpenMemory*' -not -path '*/.git/*' -not -path '*/node_modules/*' -exec rename 's/OpenMemory/Engram/g' {} +

# Lowercase codecortex -> engram
find . -depth -name '*codecortex*' -not -path '*/.git/*' -not -path '*/node_modules/*' -exec rename 's/codecortex/engram/g' {} +

# Capitalized CodeCortex -> Engram
find . -depth -name '*CodeCortex*' -not -path '*/.git/*' -not -path '*/node_modules/*' -exec rename 's/CodeCortex/Engram/g' {} +
```

---

### ⚠️ Phase 3: Bulk Text Replacement
Now we replace the text *inside* the files. We will use `find` combined with `sed` (Stream Editor). 

**Important:** We exclude `.git`, `node_modules`, `dist`, `build`, and lockfiles to prevent corrupting dependencies or git history. We also use `\b` (word boundary) for `OM_` so we don't accidentally turn `PROMPT_VAR` into `PEG_`.

```bash
echo "Replacing text inside files..."

find . -type f \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/pnpm-lock.yaml' \
  -not -path '*/package-lock.json' \
  -exec sed -i \
    -e 's/OpenMemory/Engram/g' \
    -e 's/openmemory/engram/g' \
    -e 's/CodeCortex/Engram/g' \
    -e 's/codecortex/engram/g' \
    -e 's/\bOM_/EG_/g' \
    -e 's/\bom_/eg_/g' \
    {} +

echo "Text replacement complete!"
```

---

### ⚠️ Phase 4: Manual Review & Cleanup (Crucial)
Bulk replacements are powerful, but they can occasionally over-match. You **must** review the changes before committing.

1. **Check what changed:**
   ```bash
   git status
   git diff --stat
   ```
2. **Look for accidental replacements:**
   Search your codebase for any weird artifacts. For example, did `SOME_VAR` become `SEGE_VAR`? (The `\b` word boundary in the `sed` command above prevents this, but it's good to double-check).
   ```bash
   grep -r "SEGE_" . --exclude-dir=node_modules --exclude-dir=.git
   ```
3. **Update hardcoded paths manually:**
   If you renamed `packages/openmemory-js` to `packages/engram-js`, you may need to manually update:
   - `package.json` (workspace references)
   - `docker-compose.yml` (build context paths)
   - `tsconfig.json` (path aliases, if any)
   - Any READMEs or documentation that had hardcoded directory paths.

---

### ⚠️ Phase 5: Verify Everything Still Works
Before you make this permanent, ensure the application still builds and runs.

1. **Reinstall dependencies** (since folder names changed, node_modules might be confused):
   ```bash
   rm -rf node_modules packages/*/node_modules
   npm install # or pnpm install / yarn install
   ```
2. **Build the project:**
   ```bash
   npm run build # or whatever your build command is
   ```
3. **Test the Docker setup:**
   ```bash
   docker compose down
   docker compose up --build -d
   ```
4. **Test the app:** Make a request to ensure the proxy still works and the new naming hasn't broken any internal imports.

---

### Alternative: The VS Code GUI Method (Safer but Slower)
If you are uncomfortable with command-line bulk operations, VS Code has a fantastic built-in tool for this:

1. Press `Ctrl+Shift+H` (Replace in Files).
2. Enable **Regular Expression** mode (the `.*` icon).
3. Search: `\b(OpenMemory|openmemory|CodeCortex|codecortex)\b`
4. Replace: `Engram` (or `engram` depending on context, though regex replace can't dynamically change case, so you'd have to do them one by one: `OpenMemory` -> `Engram`, then `openmemory` -> `engram`).
5. Click the **"..."** icon next to the replace field and select **"Include"** / **"Exclude"** to ignore `node_modules`, `.git`, etc.
6. Review the preview pane carefully, then click **"Replace All"**.

### Summary of the New Naming Convention
- **Project/Repo:** `Engram` / `engram`
- **Env Vars:** `EG_PG_HOST`, `EG_PORT`, etc. (instead of `OM_`)
- **Internal Vars:** `eg_port`, `eg_storage` (instead of `om_`)
- **Packages:** `packages/engram-js` (instead of `openmemory-js`)

Let me know if you want me to refine the `sed` replacements for any specific edge cases you know exist in your codebase!