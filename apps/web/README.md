# @handoff/web

Next.js 15 (Pages Router) + React 19 + Tailwind 4 front end for Handoff.

## Running

```bash
npm -w @handoff/web run dev     # http://localhost:3000
```

Environment (see `.env.example` at the repo root):

| Variable                  | Purpose                                    | Default                 |
| ------------------------- | ------------------------------------------ | ----------------------- |
| `NEXT_PUBLIC_API_URL`     | REST base URL                              | `http://localhost:3001` |
| `NEXT_PUBLIC_WS_URL`      | Socket.IO URL                              | falls back to API URL   |
| `NEXT_PUBLIC_DEV_USER_ID` | Pre-fills the development identity         | —                       |
| `NEXT_PUBLIC_DEV_PROJECT_ID` | Pre-fills the project for new tasks     | —                       |

## Router choice

The brief named both `pages/index.tsx` (Pages Router) and `layout.tsx` (App
Router); those cannot coexist in one Next application. This uses the **Pages
Router**, matching the two explicitly named page paths, with `_app.tsx`,
`_document.tsx`, and a shared `components/Layout.tsx` in place of `layout.tsx`.

Files live under `src/`, which Next supports natively and which keeps the
monorepo's TypeScript config tidy.

## Known gaps

These are UI features whose server side does not exist yet. Each degrades
visibly rather than erroring:

| Feature          | Needs                                     | Current behaviour                         |
| ---------------- | ----------------------------------------- | ----------------------------------------- |
| Comments         | `GET`/`POST /tasks/:id/comments`          | Section shows "not available yet"         |
| User autocomplete| `GET /users?q=`                           | Falls back to pasting a user id           |
| Due date on cards| `tasks.due_date` column + API field       | Card shows the created date instead       |
| Assign dropdown  | `GET /users?q=` and `POST /tasks/:id/assign` | Ownership changes go through Transfer  |
| Authentication   | Auth middleware populating `req.user`     | Dev identity prompt; id sent as a header  |

The dev identity in `lib/session.ts` is **not authentication** — anyone can set
it. It exists so the stack can be exercised end to end before auth lands.
