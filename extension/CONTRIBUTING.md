# Working on MARS Developer Tools

```bash
cd extension
npm install
npm run watch       # esbuild + tsc in watch mode
npm run compile     # type-check, lint and bundle once
npm test            # unit and integration tests
```

Press **F5** for an Extension Development Host with the extension loaded.
`src/` is what you edit; `dist/extension.js` is what ships.

## Tests

- **Unit** (`src/test/unit/`) — the Java scanner, completion, the reference
  page and the NetworkTables client against a server that speaks NT4
  (`src/test/fakeNt.ts`).
- **Integration** (`src/test/integration/`) — opens `src/test/fixture/`, a MARS
  project left in several broken states, and checks activation, where each
  diagnostic lands and what each quick fix writes. Opening that folder in the
  Development Host is also the quickest way to see the extension at work.

The scanner reads Java with regular expressions rather than a parser, so a bug
fixed in it should come with a test case that reproduces it.

## Publishing

The extension is `STZRobotics.mars-developer-tools` on the Marketplace. Bump
`version` in `package.json`, add the entry to `CHANGELOG.md`, commit, and build
the package from that commit:

```bash
npx @vscode/vsce@3 package     # -> mars-developer-tools-<version>.vsix
```

Upload it at <https://marketplace.visualstudio.com/manage>, signed in with the
account that owns the `STZRobotics` publisher: the extension's **⋯** menu →
**Update**. Or publish from the command line after `npx @vscode/vsce@3 login
STZRobotics` in an interactive terminal, with an Azure DevOps Personal Access
Token for *All accessible organizations* and the *Marketplace → Manage* scope.

`engines.vscode` and `@types/vscode` share the same minimum (`^1.85.0`): the
code must only use APIs that version has.
