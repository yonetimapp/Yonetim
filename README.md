# HomeGuru PMS

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — canonical design doc (data model, RBAC, compliance, phased plan)
- [SETUP.md](SETUP.md) — step-by-step initial setup (Supabase project, migrations, GitHub secrets, deploy)

## Quick start (local dev)

```bash
cp .env.example .env.local
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY from your Supabase project

npm install
npm run dev    # → http://localhost:5173
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint check |
| `npm run typecheck` | TypeScript check (no emit) |
| `npm run format` | Prettier rewrite |


