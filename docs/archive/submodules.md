# Git Submodules

## Active Submodules

| Path | Remote | Pinned Commit |
|---|---|---|
| `apps/langfuse` | `https://github.com/acester822/langfuse.git` | `7ee2577d8` |
| `apps/searxNcrawl` | `https://github.com/acester822/searxNcrawl.git` | `6873c3f` |

## Commands

### Clone everything (including submodules)
```bash
git clone --recurse-submodules https://github.com/acester822/FTR10-Engram.git
```

### Pull submodules after a normal clone
```bash
git submodule update --init --recursive
```

### Update a submodule to the latest from its remote
```bash
git submodule update --remote apps/langfuse
```

### Work inside a submodule (push/pull independently)
```bash
cd apps/langfuse
git pull origin main   # or whatever branch
# make changes, commit, push as normal
cd ../..
git add apps/langfuse  # update parent's pinned commit
```

### Add a new submodule
```bash
git submodule add <repo-url> <path>
```

### Remove a submodule
```bash
git submodule deinit -f <path>
git rm -f <path>
rm -rf .git/modules/<path>
```