# VibeChat — private room chat

VibeChat is a small static website for private, password-protected text and emoji chat rooms.
It uses GitHub Pages for hosting and Supabase for anonymous sign-in, database storage and realtime updates.

## 1. Create the Supabase backend

1. Create a project at https://supabase.com/.
2. Open **SQL Editor → New query**, paste the entire contents of `supabase-setup.sql` (not just the final policy section), and run it. The script creates the tables, functions and security policies.
3. Open **Authentication → Providers** and enable **Anonymous Sign-Ins**.
4. Open **Database → Publications** (or the Realtime settings) and add `chat_messages` to the `supabase_realtime` publication.
5. Open **Project Settings → API**. Copy the Project URL and the `anon` / publishable public key.

## 2. Configure this website

1. Open `config.js`.
2. Replace `https://YOUR-PROJECT.supabase.co` with your Supabase Project URL.
3. Replace `YOUR_SUPABASE_ANON_PUBLIC_KEY` with the anon/public key.
4. Save the file.

The anon/public key is designed for browser use. **Never paste a `service_role` or secret key into this project.**

## 3. Publish on GitHub Pages

1. Create a new GitHub repository.
2. Upload `index.html`, `style.css`, `app.js`, `config.js`, and (optionally) `README.md`.
3. In the repository, open **Settings → Pages**.
4. Under Build and deployment, choose **Deploy from a branch**.
5. Choose your `main` branch and `/ (root)` folder, then Save.
6. Wait for GitHub Pages to publish and open the displayed website URL.

Keep `supabase-setup.sql` in your own project notes or repository if you want, but it is not needed by the website at runtime.

## 4. How to use

- Enter a display name.
- Create a room using a unique room ID/name and a password of at least 6 characters.
- Share the room ID and password with the people you want to invite.
- They open the same GitHub Pages URL, enter their own display name, and join with the room ID and password.

## Notes and limitations

- This is a starter app: text and emoji only; no image, voice or video uploads.
- Messages are stored in Supabase and the latest 100 are loaded when a member enters a room.
- Anyone who knows both the room ID and password can join. Use a strong, unique password.
- Usernames are display names, not verified identities. Anonymous sessions are tied to the browser/device session.
- There is no room deletion or message deletion interface yet.
- Configure Supabase project security, backups and usage limits before relying on this for important or sensitive conversations.
- This app uses browser-side Supabase access protected by Row Level Security. Do not disable RLS.
