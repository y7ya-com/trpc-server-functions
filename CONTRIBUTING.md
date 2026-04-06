# Contributing

## Development

```bash
npm install
npm run check
npm run build
```

## Demo

```bash
cd demo
pnpm install
pnpm dev
```

## Guidelines

- Keep the public API limited to `createServerFn().query(...)` and `.mutation(...)`.
- Preserve the split client/server model: Vite generates modules, the server imports real files.
- Update the README when the setup or authoring API changes.
- Run `npm run check` and `npm run build` before opening a change.

## Versioning

This package follows semver.
