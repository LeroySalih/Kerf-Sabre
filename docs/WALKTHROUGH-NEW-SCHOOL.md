# Walkthrough: a new school joins Kerf

This walks through what a teacher sees, from "I have heard of Kerf" to "I am my school's admin, I have invited a colleague and made a group". It describes the code on `main` as of shared 0.2.38 plus the public website (landing page at `/`, pricing at `/pricing`, one sign-in page at `/sign-in`, the Editor at `/editor/`). Anything marked **Not built yet** does not work today.

The example school is **Westfield High** (school ID `westfield-high`). The teacher is `you@westfield-high.example` and the colleague is `colleague@westfield-high.example`.

## Before you try this (owner only)

- The production `.env` (`server/deploy/.env`) needs:
  - `RESEND_API`: the Resend key. Without it, emails are not sent. The server keeps them in memory instead, which is for development only.
  - `KERF_PUBLIC_URL=https://kerf.mr-salih.org`. Every link in an email is built from this address. Without it, inviting someone or asking for a sign-in link fails with `503 email_not_set_up` ("Email sign-in is not set up on this server yet (KERF_PUBLIC_URL is missing).").
- Run `./deploy.sh` on the server to put the latest `main` live. It backs up first, then pulls and rebuilds.
- To use the Platform pages in a browser, go to `https://kerf.mr-salih.org/sign-in`, choose **I'm staff** and press **Sign in with DINO**, using a DINO account whose ID is listed in `KERF_SITE_ADMINS`. A stored platform token also counts as a site admin, but only through the API (for example with `curl`). The Admin site no longer has a box to paste a token into.

## The steps

1. **The school asks to join.** Schools cannot sign themselves up yet (see "Not built yet"). The teacher contacts Kerf (mr-salih.org) and gives the school's name and their school email address.

2. **The site admin creates the school.** In the Admin site (`https://kerf.mr-salih.org/admin/`), signed in with DINO, press **Kerf Platform** in the header. Then go to **Schools** and press **New school…**. Fill in:
   - **School ID**: `westfield-high` (lower-case letters, digits and `-`, up to 32 characters).
   - **Name**: `Westfield High`.
   - **First admin's email (optional)**: `you@westfield-high.example`.

   Press **Create**. You then see "An invite is on its way to you@westfield-high.example." The new school:
   - is on the **Free** plan, with its own copy of Kerf's default terms (see step 9);
   - gets a 5-character school code, for example `K7RPX` (the letters and digits are chosen so none look alike);
   - has two sign-in methods switched on: **Group code** and **Email link**. **DINO**, **Google** and **Microsoft** are off.

   Behind the scenes this is `POST /schools {id, name, adminEmail, adminName}`. If the invite email cannot be sent, nothing is created, so you can fix the problem and press **Create** again.

3. **The teacher gets an invite email.**
   - From: `Kerf <kerf-no-reply@mr-salih.org>`.
   - Subject: **You are invited to Kerf (Westfield High)**.
   - Heading: "You are invited to Kerf".
   - Body: "You have been invited to Kerf, the laser design and cutting service used by Westfield High, as a school admin. Press the button to sign in for the first time. The link works once, for 7 days. Later, ask for a new sign-in link on the sign-in page."
   - An orange **Sign in to Kerf** button, with the address written out below it.
   - Footer: "If you were not expecting this, you can ignore it."

   The link goes to `https://kerf.mr-salih.org/sign-in?signin=…&app=admin`.

4. **The teacher clicks the link.** The sign-in page opens, says it is signing them in, then opens the Admin site, signed in as **School admin**. The link is removed from the address bar, so it cannot be bookmarked or used again. The sign-in lasts about 10 hours, and only in that browser tab: closing the tab signs them out.

5. **What the teacher sees.**
   - The header shows **Kerf Admin**, then "Westfield High · school code K7RPX · Free plan · School admin: st-…". The last part is their Kerf person ID, not their name. On the right are **Editor** and **Sign out**.
   - A free school's admin gets five pages: **Classes**, **Pupils**, **Materials**, **School** and **Staff**. **Classes** opens first.
   - **Classes**: one row per group, showing its join code, note, teacher and number of pupils. The buttons are **New class…**, **Pupils…**, **Edit…** (change the note or join code) and **Archive** (archived groups can be brought back with **Show archived classes**).
   - **Pupils**: every pupil in the school by group, shown by pupil ID only, with **Remove**. Pupils removed from their last group appear under "Archived pupils", where **Delete for good…** deletes them permanently.
   - **Materials**: the laser settings for each material (power, speed, passes and kerf). Changing them only matters once the school has the laser.
   - **School**: the school's name, its **School code**, the plan ("Plan: Free" plus what the terms give, for example "free tools only · " followed by the group, pupil and file limits), and a **How people sign in** table with a tick box for each of **Group code**, **Email link**, **DINO**, **Google** and **Microsoft**. Every method except Email link and DINO is marked "Coming soon: can be set now, starts working when it is released." DINO's box is greyed out with "Linked to another school on this server." You cannot switch off every way staff sign in.
   - **Staff**: **Invite staff…** and a list of people invited by email, showing Name, Email, Role and Status (**Invited**, or "Signed in" with a date). People still marked Invited have **Send again**. Everyone except you has **Remove**. Staff who sign in with DINO are not listed here.

6. **Invite a colleague.** On **Staff**, press **Invite staff…**. Fill in **School email address**, **Name (optional)** (shown to your school's staff only) and **Role**: **Teacher**, **School admin** or **Technician (laser stations only)**. Press **Send invite**, and you see "An invite is on its way to colleague@westfield-high.example."
   - The colleague gets the same email as in step 3, but with "as a teacher" (or "as a technician (laser stations)").
   - Until they use the link, they show as **Invited**. **Send again** sends a fresh 7-day link.
   - A colleague who has already signed in cannot be invited again. They should ask for a sign-in link instead (step 7).
   - A free school's technician sees nothing in the Admin site ("Your school is on Kerf's free plan, which has no Station pages."). Technicians are only useful on the paid plan.

7. **Sign in again later.**
   - Go to `https://kerf.mr-salih.org/sign-in` (or press **Sign in** on the landing page; going to `/admin/` or `/editor/` while signed out also brings you here). Choose **I'm staff**, type your **School email address** and press **Send me a sign-in link**. The panel then says **Check your email**. The link works once, for 15 minutes, and opens the Admin site.
   - The answer is always the same, whether or not the address has an account: "If that address belongs to a Kerf account, a sign-in link is on its way. Check your email (and your junk folder)."
   - The email's subject is **Your Kerf sign-in link (Westfield High)**.
   - Each address can get 3 links per 15 minutes, and each computer can ask 20 times per 15 minutes.
   - If you came to the sign-in page from the Editor (`/editor/`), the link opens the Editor instead of the Admin site.
   - If the address has accounts at more than one school, a separate link arrives for each school.

8. **Make a group and add pupils.**
   - On **Classes**, press **New class…**. Fill in **Class code (optional)** (leave it blank and Kerf makes one) and **Note (optional)** (for example "Year 9 set 2", never a pupil's name). Press **Create**.
   - Press **Pupils…** on the new row, open the class, press **Add pupils…** and paste the pupils' IDs (described as their DINO IDs), one per line. An ID already used in another school is not added ("Used in another school, not added").
   - **Pupils at a new school cannot sign in yet.** Today pupils sign in only with DINO, and DINO sign-ins belong to the one school the server links to DINO (`KERF_SSO_SCHOOL`). Westfield High cannot switch DINO on. The group code sign-in that the School page describes ("Pupils type the school code, their group code, their pupil ID and the password on their card") has no sign-in screen yet. So a new school can set up groups, but its pupils cannot use them.
   - Pupils, or anyone else, can still design in the Editor: **Work without signing in** on the sign-in page opens the Editor, and the work stays in that browser. The **Use your Pupil Card** form on the sign-in page is shown but marked **Coming soon**.

9. **What the free plan includes.** Kerf's built-in default terms are:
   - features: the free tools only (no laser, no activities);
   - limits: 20 groups in a school, 50 pupils in a group and 20 files per pupil.

   A school keeps the copy it got when it was created, so later changes to the default do not affect it. Going over a limit gives, for example, "Your school's plan allows up to 20 groups in a school."

   The laser is a paid feature. It covers sending files, the queue and approval (where files are merged and reordered), the lasers, Station pages, the Cutter download and the camera. Activities and teacher feedback are also paid. A free school's terms can add either feature, or a time-limited grant such as a trial.

   **To move a school to paid**, the site admin goes to **Kerf Platform** → **Schools** and changes that school's **Plan** from **Free** to **Paid** (this is `PATCH /schools/{id} {"plan": "paid"}`). A paid school gets everything with no limits. To give a free school extras instead, use **Terms…** on its row (`PUT /schools/{id}/terms`). The **Default terms** page sets what new free schools get. There is no payment or billing in Kerf yet: the site admin does this by hand.

## Not built yet

- **Self-registration**: a teacher cannot sign their school up. The site admin creates every school (step 2).
- **Pupil sign-in for new schools**: there is no sign-in screen for the school code, group code and password, and no Pupil Cards. Only the school linked to DINO has working pupil sign-in.
- **Google and Microsoft sign-in**: the tick boxes exist but say "Coming soon". They also stay greyed out until Kerf is registered with Google and Microsoft.
- **Public pages**: the landing, pricing and sign-in pages are built. Things on them that do not work yet are greyed out and marked **Coming soon**: Pupil Card sign-in, Google and Microsoft, **Register your school (free)**, prices, **Talk to us**, and the Privacy, Terms and Contact links.
- **Payment**: moving a school to paid is a manual switch for the site admin.

## If something goes wrong

- **"That sign-in link has expired or has already been used. Ask for a new one."** Invite links last 7 days and sign-in links last 15 minutes, and each works once. Ask for a new link on the sign-in page (step 7). For an invite that was never used, ask an admin to press **Send again**. The same message appears for a link that was mistyped or cut short.
- **No email arrives.** Look in the junk or spam folder. The sender is `kerf-no-reply@mr-salih.org`. If you asked several times, wait 15 minutes, because only 3 links go to each address in that time. "Too many sign-in links asked for from this computer. Wait a few minutes." means the computer's limit was reached. "Kerf could not send the email just now. Try again in a minute." means Resend refused the email or could not be reached.
- **"Email sign-in is switched off for your school. Ask your school's Kerf admin."** (`sign_in_off`): an admin has unticked **Email link** on the **School** page. Asking for a link then sends nothing, but still shows the usual "If that address belongs…" message.
- **Removed staff**: **Remove** signs the person out at once and cancels their unused links. Their sign-in requests send nothing, and an old link gives the "expired or already been used" message. An admin can invite them again from **Staff**.
- **"Your sign-in is no longer valid. Sign in again."**: the session ended, either after about 10 hours or because you were removed. Ask for a new link.
- **`503 email_not_set_up`** when creating a school or inviting someone: `KERF_PUBLIC_URL` is missing on the server (owner: see "Before you try this").
