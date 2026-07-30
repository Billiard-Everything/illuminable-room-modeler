# Deployment Guide

This guide walks you through putting the whole app online, for free, so
anyone with the link — including your professor — can use it. It assumes
**zero deployment experience**. Every step says exactly what to click.

If you get stuck, the [Troubleshooting](#troubleshooting) section near the
bottom covers the most common snags.

## What you're deploying

This app has three pieces, hosted in three different places:

| Piece | What it is | Where it lives |
|---|---|---|
| **Frontend** | The React app you see in the browser | GitHub Pages (free) |
| **Backend API** | A small Node server that talks to the database | Render (free) |
| **Database** | Stores the shared graph library | Supabase (free) |

They talk to each other like this:

```
Your browser  --->  GitHub Pages (frontend)
                          |
                          v  (fetch calls)
                     Render (backend API)
                          |
                          v
                    Supabase (PostgreSQL)
```

The frontend and backend are two **separate** deployments that both need to
know about each other's URL. That's the main thing this guide sets up.

You'll do the steps in this order, because each one produces a value the
next one needs:

1. **Supabase** — get a database connection string.
2. **Render** — deploy the backend, using that connection string. You get
   back a Render URL.
3. **GitHub Pages** — deploy the frontend, telling it about that Render URL.
4. Go back to Render and lock the backend down to only accept requests from
   your new GitHub Pages URL.

---

## Step 1 — Set up Supabase (the database)

1. Go to [supabase.com](https://supabase.com) and click **Start your
   project** (or **Sign in** if you already have an account). Sign up with
   GitHub — it's the fastest option.
2. Click **New project**.
3. Fill in:
   - **Name**: anything, e.g. `illuminable-room-modeler`.
   - **Database Password**: click **Generate a password**, then **copy it
     somewhere safe** (a notes app, password manager — anywhere you won't
     lose it). You will need it in a minute and Supabase will not show it
     to you again.
   - **Region**: pick whichever is closest to you or your professor.
4. Click **Create new project**. Wait 1–2 minutes while Supabase sets
   everything up (there's a progress screen).
5. Once it's ready, go to the left sidebar and click the **gear icon**
   (**Project Settings**), then **Database**.
6. Scroll to **Connection string**. Click the **URI** tab.
7. You'll see something like:
   ```
   postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```
   Copy this whole string, then replace `[YOUR-PASSWORD]` with the real
   password you saved in step 3. **This full string is your `DATABASE_URL`
   — keep it secret, you'll paste it into Render in the next step.**

   Supabase offers a couple of different connection modes on this page
   ("Transaction", "Session", etc.) — either works fine for this app; if
   one gives you trouble, try the other.

That's it for Supabase. You don't need to create any tables yourself — the
backend does that automatically the first time it starts up (see
`server/db/migrations/`).

---

## Step 2 — Set up Render (the backend API)

1. Go to [render.com](https://render.com) and sign up (GitHub sign-in is
   fastest again).
2. Click **New +** (top right) → **Blueprint**.
3. Connect your GitHub account if prompted, then find and select **your
   fork** of this repository (`illuminable-room-modeler`).
4. Render will read this repo's `render.yaml` file and show you a preview
   of one service it's about to create
   (`illuminable-room-modeler-api`). Click **Apply** (or **Deploy
   Blueprint**, depending on Render's current wording).
5. Render will ask you to fill in two values it doesn't know
   automatically (because `render.yaml` deliberately leaves them blank —
   see that file's own comments):
   - **DATABASE_URL** — paste the full connection string you built in
     Step 1.
   - **CORS_ORIGIN** — leave this **blank** for now (or type `*`). You'll
     come back and fix this in Step 4, once you know your GitHub Pages URL.
6. Click **Create Web Service** / **Deploy**. Render will build and start
   the backend — this takes a couple of minutes the first time. You can
   watch progress in the **Logs** tab.
7. Once it says the service is **Live**, find its URL near the top of the
   page — it looks like:
   ```
   https://illuminable-room-modeler-api.onrender.com
   ```
   **Copy this URL — you need it for Step 3.**
8. Confirm it's actually working: open
   `https://your-service-name.onrender.com/health` in a browser tab. You
   should see:
   ```json
   {"status":"ok"}
   ```

### If you'd rather not use the Blueprint button

You can also create the service by hand: **New +** → **Web Service** → pick
your repo → set **Build Command** to `npm install`, **Start Command** to
`npm run server:api`, **Health Check Path** to `/health`, and add the same
two environment variables (`DATABASE_URL`, `CORS_ORIGIN`) under the
**Environment** tab. The Blueprint just does all of this for you from
`render.yaml`.

> **A note on Render's free tier**: a free web service goes to sleep after
> 15 minutes of no traffic and takes ~30–60 seconds to wake back up on the
> next request. That's normal — the app is built to keep working while
> that happens (see `remoteGraphRepository.js`'s own timeout/fallback
> behavior), it'll just feel slow on the very first request after a quiet
> period.

---

## Step 3 — Set up GitHub Pages (the frontend)

1. In your fork on GitHub, go to **Settings** → **Pages** (left sidebar,
   under "Code and automation").
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**
   (not "Deploy from a branch"). This repo already has a workflow file
   (`.github/workflows/deploy.yml`) that knows how to build and publish the
   app — you're just telling GitHub to use it.
3. Now go to **Settings** → **Secrets and variables** → **Actions**.
4. Click the **Variables** tab (not **Secrets** — this value is a public
   URL, not something sensitive).
5. Click **New repository variable**:
   - **Name**: `VITE_GRAPH_API_URL`
   - **Value**: the Render URL from Step 2, e.g.
     `https://illuminable-room-modeler-api.onrender.com`
   - Click **Add variable**.
6. Trigger a deploy. Either:
   - Push any commit to `main` (merging a PR counts), or
   - Go to the **Actions** tab, click **Deploy to GitHub Pages** in the
     left list, click **Run workflow** → **Run workflow** (this manually
     triggers it without needing a new commit).
7. Watch the run in the **Actions** tab. When it finishes with a green
   check, go back to **Settings** → **Pages** — your live URL is shown at
   the top, something like:
   ```
   https://your-username.github.io/illuminable-room-modeler/
   ```
   **Copy this URL — you need it for Step 4.**

---

## Step 4 — Lock the backend down to your frontend

Right now your backend still accepts requests from any website
(`CORS_ORIGIN` was left blank/`*` in Step 2). Let's fix that:

1. Go back to your Render service (**Dashboard** → your service name).
2. Go to the **Environment** tab.
3. Find `CORS_ORIGIN` and set its value to your GitHub Pages URL from
   Step 3, **without a trailing slash**, e.g.:
   ```
   https://your-username.github.io
   ```
4. Click **Save Changes**. Render will automatically restart the service
   with the new setting (takes under a minute).

Open your GitHub Pages URL, click **Graph Library** in the sidebar, and
confirm it loads without a "Couldn't reach the shared graph library"
message. You're live! 🎉

---

## Environment variables reference

| Variable | Where it's set | What it's for |
|---|---|---|
| `DATABASE_URL` | Render | Supabase connection string (Step 1) |
| `CORS_ORIGIN` | Render | Your GitHub Pages URL, so only your frontend can call the API |
| `PORT` | Render (set automatically) | Which port the backend listens on — you never set this yourself |
| `VITE_GRAPH_API_URL` | GitHub Actions (repo Variable) | Your Render URL, baked into the frontend at build time |
| `PGSSL` | Render (optional) | Only needed if you must force SSL on/off — see `.env.example` |

For **local development on your own machine**, copy `.env.example` to
`.env` and fill in a local Postgres instead (see that file's own comments)
— you don't need any of the cloud accounts above just to run the app on
your laptop.

---

## How to update the app later

Both deployments are already wired to redeploy automatically:

- **Frontend**: push (or merge a PR) to `main` → the
  `Deploy to GitHub Pages` Action rebuilds and republishes automatically.
- **Backend**: Render watches the same repo/branch by default — pushing to
  `main` triggers a new build and deploy there too. (Check your service's
  **Settings** → **Build & Deploy** tab if you ever want to change which
  branch it watches.)

If you ever change `server/db/migrations/` (add a new migration file), you
don't need to do anything extra — `server/api/start.js` applies any new,
not-yet-applied migrations automatically every time the backend starts
(including after every redeploy).

If you ever need to run a migration by hand (e.g. from your own machine
against the production database), set `DATABASE_URL` in your local `.env`
to the Supabase connection string and run:

```
npm run migrate
```

---

## How your professor (or anyone else) can deploy their own copy

Every piece of this is per-account, so a second person doesn't share
anything with your deployment — they get their own independent copy:

1. They click **Fork** on the GitHub repository to get their own copy.
2. They repeat **Step 1** (Supabase) under their own Supabase account —
   their own free project, their own database.
3. They repeat **Step 2** (Render) under their own Render account, using
   their fork and their own Supabase connection string.
4. They repeat **Step 3** (GitHub Pages) on their own fork's Settings.
5. They repeat **Step 4** with their own two URLs.

Nothing in this repo hardcodes your Supabase project, your Render service,
or your GitHub username anywhere — every connection between the three
pieces is made through the environment variables above, which is exactly
what makes this repeatable.

---

## Troubleshooting

**"Couldn't reach the shared graph library" in the Graph Library panel**
- Open your Render service's **Logs** tab and check it's actually running
  (not crashed).
- Visit `https://your-service.onrender.com/health` directly — if that
  doesn't return `{"status":"ok"}`, the backend itself is down; check the
  Render logs for the reason (often a bad `DATABASE_URL`).
- If `/health` works but the app still can't reach it, double-check
  `VITE_GRAPH_API_URL` (GitHub repo Variables) exactly matches your Render
  URL, including `https://` and no trailing slash, then re-run the
  **Deploy to GitHub Pages** Action (this value is baked in at build time,
  so a typo fix requires a rebuild, not just re-saving the variable).

**CORS error in the browser console (mentions "Access-Control-Allow-Origin")**
- Your `CORS_ORIGIN` on Render doesn't match your GitHub Pages URL exactly
  — check for a trailing slash or `http` vs `https` mismatch.

**The first request after a while is really slow**
- Normal on Render's free tier — see the note at the end of Step 2. It
  wakes up within about a minute.

**Render build fails**
- Check the **Logs** tab for the actual error. A missing/incorrect
  `DATABASE_URL` will show up once the service *starts* (not during the
  build itself), as a migration warning in the logs — the service still
  starts either way (see `server/api/start.js`'s own comment on why), but
  every database-backed feature will fail until it's fixed.

**GitHub Pages shows a blank page or 404**
- Confirm **Settings → Pages → Source** is set to **GitHub Actions**, not
  "Deploy from a branch."
- Confirm the **Deploy to GitHub Pages** Action actually succeeded (green
  check) in the **Actions** tab.
