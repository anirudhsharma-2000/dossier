# Running Dossier on Vercel (free)

This fork runs on Vercel's free Hobby plan with a free Neon PostgreSQL database, instead of on your own server. It also adds a connector so you can use Dossier from Claude chat, and job searches for a city plus remote jobs (Bangalore + remote in India by default).

Everything else works as in the [README](README.md); the differences are at the end of this page.

## What you need

- A GitHub account with this fork (`anirudhsharma-2000/dossier`).
- A free [Vercel](https://vercel.com/signup) account, signed in with GitHub.
- Three secrets, made once on your Mac:

```sh
# DOSSIER_SECRET: signs sessions and encrypts saved API keys
openssl rand -base64 32
# CRON_SECRET: lets only Vercel's daily job run the nightly backup
openssl rand -hex 32
# DOSSIER_PASSWORD: a hash of the password you'll sign in with (type it twice)
docker run --rm -it --platform linux/amd64 ghcr.io/aientech/dossier hash-password
```

Keep the three values somewhere safe, such as a password manager.

## 1. Create the project

1. On Vercel, choose **Add New → Project**, and import **anirudhsharma-2000/dossier**.
2. Open **Environment Variables** on the same screen and add:

| Name | Value |
| --- | --- |
| `DOSSIER_SECRET` | the `openssl rand -base64 32` output |
| `DOSSIER_PASSWORD` | the `argon2id:…` line from `hash-password` |
| `CRON_SECRET` | the `openssl rand -hex 32` output |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` (Dossier uses Yarn 4) |

3. Press **Deploy**. This first build **fails**, because there's no database yet. That's expected.

## 2. Add the database

1. In the project, open **Storage → Create Database → Neon** (the free plan is enough) and connect it to the project for all environments. Vercel adds `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for you.
2. Open **Deployments**, then the **⋯** menu on the latest one → **Redeploy**.

The build creates the tables and the built-in themes. When it's done, open your production address, `https://<project-name>.vercel.app`, and sign in.

Use that production address (or your own domain), not the long address of a single deployment: Vercel's Deployment Protection guards those, and PDFs are printed through the production address. With your own domain, also set `DOSSIER_PUBLIC_URL` to it, e.g. `https://dossier.example.com`.

## 3. Set Dossier up

- **Settings → AI provider** (optional): Dossier's own AI features (New application, refining in the chat, scoring postings) need an API key. Without one, have Claude chat write your applications through the connector (step 4). Local models don't work on Vercel.
- **Settings → Job search → JSearch**: your OpenWeb Ninja or RapidAPI key, with the matching host.
- **Profile**: set your city to **Bangalore** and your country to **India**. Find jobs then starts with Bangalore plus remote jobs across India; untick **Plus remote jobs** for Bangalore only.

## 4. Connect Claude

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Name it **Dossier**, and give the address `https://<project-name>.vercel.app/api/mcp`.
3. Press **Connect**. Dossier opens; sign in if it asks, then press **Allow**.

Then ask Claude things like "find Android developer jobs in Bangalore or remote", "write an application for number 3" or "what's the status of my applications?". Claude can search, read your profile and postings, write the tailored resume and cover letter itself and save them in Dossier as a Draft (so Dossier needs no AI key of its own), and change an application's status. With "Never invent experience" on, Dossier marks names and numbers Claude wrote that your profile doesn't back. It can't send anything: drafts wait in Dossier for you. Changing `DOSSIER_PASSWORD` disconnects Claude, as it signs out every browser.

## How it differs from a server of your own

- **Five minutes per task.** Each AI task must finish within Vercel's 5-minute limit; with a hosted model it takes well under. A task cut off shows "This took longer than the server allows" with Retry.
- **4.5 MB per upload and download.** Vercel caps request and response bodies, so data imports, "Download all PDFs" zips and exports over 4.5 MB fail. Download PDFs one at a time instead.
- **Schedules.** A Vercel Cron Job runs once a day at about 03:00 India time (the free plan allows one run a day, within the hour): the nightly backup, tidying up and the job agent. The agent's own hour and the inbox check also run on your page views, once they're due.
- **Backups live in the database.** Nightly backups are kept in Neon, not in a folder; **Settings → Your data → Download the latest backup** gets the newest one. Export your data now and then too, since a backup in the same database doesn't survive losing the database.
- **Storage.** Neon's free plan has 0.5 GB, plenty for one person. Lower `DOSSIER_BACKUP_RETENTION_DAYS` if it fills up.
- **Time zone.** Vercel's servers run on UTC and `TZ` can't be changed there, so backup file names use UTC.

To update to a newer upstream Dossier, sync the fork on GitHub (**Sync fork**) and Vercel deploys it.
