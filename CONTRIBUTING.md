# Contributing

Bug reports and pull requests are welcome.

- **Bugs:** open an issue with your OS and Obsidian version and the lines from `backup-errors.log` in the plugin folder.
- **Code:** the source is in `src/` and `backup-core.js`; `main.js` is generated from them, so run `npm run build` and commit the result together with your change (CI refuses a `main.js` that does not match the source).
- **Tests:** `npm test`.
- **Style:** plain CommonJS JavaScript, no framework; keep the surrounding code's comment density and naming.
- **Releases** are cut by the maintainer with `npm run release` after bumping the version in `manifest.json`, `package.json` and `versions.json`.
