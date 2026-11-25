# Walkthrough: a new school joins Kerf

This walks through what a teacher sees, from "I have heard of Kerf" to "I am my school's admin, I have invited a colleague and made a group". It describes the code on `main` as of shared 0.2.47 plus the public website (landing page at `/`, pricing at `/pricing`, one sign-in page at `/sign-in`, registration at `/register`, the Editor at `/editor/`). Anything marked **Not built yet** does not work today.

The example school is **Westfield High** (school ID `westfield-high`). The teacher is `you@westfield-high.example` and the colleague is `colleague@westfield-high.example`.

## Before you try this (owner only)

- The production `.env` (`server/deploy/.env`) needs:
  - `RESEND_API`: the Resend key. Without it, emails are not sent. The server keeps them in memory instead, which is for development only.
  - `KERF_PUBLIC_URL=https://kerf.mr-salih.org`. Every link in an email is built from this address. Without it, registering, inviting someone or asking for a new password fails with `503 email_not_set_up` ("Email sign-in is not set up on this server yet (KERF_PUBLIC_URL is missing).").
  - Optional: `KERF_ADMIN_EMAIL=<your address>` to get one line ("A new free school registered on Kerf: Westfield High (westfield-high).") whenever a school registers. `KERF_REGISTRATION=false` closes registration (the page then says "Registration is closed").
- Run `./deploy.sh` on the server to put the latest `main` live. It backs up first, then pulls and rebuilds.
- To use the Platform pages in a browser, go to `https://kerf.mr-salih.org/sign-in`, choose **I'm staff** and press **Sign in with DINO**, using a DINO account whose ID is listed in `KERF_SITE_ADMINS`. A stored platform token also counts as a site admin, but only through the API (for example with `curl`). The Admin site no longer has a box to paste a token into.

## The steps

1. **The teacher registers the school.** On the landing page, the pricing page or the sign-in page, press **Register your school (free)** (or **Register free**, or **New school? Register free**). This opens `https://kerf.mr-salih.org/register`. Fill in:
   - **School name**: `Westfield High`.
   - **Your name**: for example `Sam Taylor` (shown to your school's staff; never logged).
   - **Your school email**: `you@westfield-high.example`.
   - Tick **I work at this school and may sign it up**.

   Press **Register free**. The panel then says **Check your email**: "If that address can receive email, a link to confirm your school is on its way. Check your junk folder." and "The link works once, for 24 hours. Nothing is set up until you press it." The answer is the same whatever happens, so the page never says whether the address already has an account. Each address can register 3 times per 15 minutes, and each computer 10 times a day ("Too many schools registered from this computer today. Try again tomorrow."). Behind the scenes this is `POST /auth/register {schoolName, name, email}`.

   *Alternative:* the site admin can still create a school by hand, for example a paid school. In the Admin site, signed in with DINO, press **Kerf Platform**, then **Schools** → **New school…** and fill in **School ID**, **Name** and **First admin's email (optional)**. The first admin then gets an invite email ("You are invited to Kerf (Westfield High)", a 7-day link to `/sign-in?signin=…&app=admin` that opens **Choose a password**) instead of the confirmation email below, and goes on from step 3 (choosing a password). This is `POST /schools {id, name, adminEmail, adminName}`.

2. **The teacher gets a confirmation email.**
   - From: `Kerf <kerf-no-reply@mr-salih.org>`.
   - Subject: **Confirm your school on Kerf (Westfield High)**.
   - Body: "Thank you for registering Westfield High on Kerf, the free laser design tools for schools. Press the button to confirm and choose your password. Kerf then sets up Westfield High on the free plan, makes you its admin and signs you in. Next you add your teachers, make groups and print Pupil Cards for your pupils. The link works once, for 24 hours. Nothing is set up until you press it."
   - An orange **Confirm my school** button, with the address written out below it.
   - Footer: "If you did not register a school on Kerf, you can ignore this email: nothing will be set up."

   The link goes to `https://kerf.mr-salih.org/sign-in?register=…`.

   - The button says **Confirm and choose a password**.

3. **The teacher clicks the link, chooses a password, and the school is made.** The sign-in page shows **Confirm your school: choose a password**: a **New password** box, **Type it again**, **Show password**, and the rules ("At least 10 characters. Three random words work well, like "violet canal biscuit"." and "Not your email address, and not a common password."). A short or common password gets a plain message such as "Use at least 10 characters. Three random words work well." and the link stays usable. Press **Save password and set up my school**: Kerf then opens the Admin site, signed in as **School admin**. From now on the teacher signs in with their school email and this password. The new school:
   - has the school ID made from its name: `westfield-high` (lower case, dashes, up to 32 characters; if that ID is taken, `westfield-high-2`, `-3` and so on);
   - is on the **Free** plan, with its own copy of Kerf's default terms (see step 9);
   - gets a 5-character school code, for example `K7RPX` (the letters and digits are chosen so none look alike);
   - has two sign-in methods switched on: **Group code** and **Email and password**. **DINO**, **Google** and **Microsoft** are off.

   A link that was used already, or is more than 24 hours old, shows "That link has expired or has already been used. If you have already confirmed your school, sign in with your email and password. Otherwise, register again." with **Register your school again**.

4. **Signed in.** The link is removed from the address bar, so it cannot be bookmarked or used again. The sign-in lasts about 10 hours, and only in that browser tab: closing the tab signs them out. Later they sign in as in step 7.

5. **What the teacher sees.**
   - The header shows **Kerf Admin**, then "Westfield High · school code K7RPX · Free plan · School admin: st-…". The last part is their Kerf person ID, not their name. On the right are **Editor**, **Change password…** (current password, new password twice; every other computer is signed out) and **Sign out**.
   - A free school's admin gets five pages: **Classes**, **Pupils**, **Materials**, **School** and **Staff**. **Classes** opens first.
   - **Classes**: one row per group, showing its join code, note, teacher and number of pupils. The buttons are **New class…**, **Pupils…**, **Edit…** (change the note or join code) and **Archive** (archived groups can be brought back with **Show archived classes**).
   - **Pupils**: every pupil in the school by group, shown by pupil ID only, with **Remove**. Pupils removed from their last group appear under "Archived pupils", where **Delete for good…** deletes them permanently.
   - **Materials**: the laser settings for each material (power, speed, passes and kerf). Changing them only matters once the school has the laser.
   - **School**: the school's name, its **School code**, the plan ("Plan: Free" plus what the terms give, for example "free tools only · " followed by the group, pupil and file limits), and a **How people sign in** table with a tick box for each of **Group code**, **Email and password**, **DINO**, **Google** and **Microsoft**. Every method except Email and password, Group code and DINO is marked "Coming soon: can be set now, starts working when it is released." DINO's box is greyed out with "Linked to another school on this server." You cannot switch off every way staff sign in.
   - **Staff**: **Invite staff…** and a list of people invited by email, showing Name, Email, Role and Status (**Invited**, or "Signed in" with a date). People still marked Invited have **Send again**. Everyone except you has **Remove**. Staff who sign in with DINO are not listed here.

6. **Invite a colleague.** On **Staff**, press **Invite staff…**. Fill in **School email address**, **Name (optional)** (shown to your school's staff only) and **Role**: **Teacher**, **School admin** or **Technician (laser stations only)**. Press **Send invite**, and you see "An invite is on its way to colleague@westfield-high.example."
   - The colleague gets an invite email: subject **You are invited to Kerf (Westfield High)**, "You have been invited to Kerf, the laser design and cutting service used by Westfield High, as a teacher" (or "as a technician (laser stations)"), "Press the button to choose your password…", and an orange **Choose your password** button. The link works once, for 7 days, opens **Choose a password** on the sign-in page, and then the Admin site.
   - Until they choose a password, they show as **Invited**. **Send again** sends the invite again with a fresh 7-day link.
   - A colleague who has already signed in cannot be invited again. They sign in with their email and password, and use **Forgot your password?** if they have lost it (step 7).
   - A free school's technician sees nothing in the Admin site ("Your school is on Kerf's free plan, which has no Station pages."). Technicians are only useful on the paid plan.

7. **Sign in again later.**
   - Go to `https://kerf.mr-salih.org/sign-in` (or press **Sign in** on the landing page; going to `/admin/` or `/editor/` while signed out also brings you here). Choose **I'm staff**. Under "or sign in with your school email", type your **School email address** and **Password** and press **Sign in**. The Admin site opens (or the Editor, if the Editor sent you to the sign-in page).
   - A wrong address or a wrong password gives the same message: "That email address or password is not right." Five wrong passwords in a row lock the account for 15 minutes ("Too many wrong passwords. This account is locked for 15 minutes. Wait, or use Forgot your password? to set a new one.").
   - If the same email and password work at more than one school, the panel asks **Choose your school** with a button for each.
   - **Forgot your password?** (under the Sign in button; type your email first) emails a link: "If that address has a Kerf account, a link to set a new password is on its way." The email's subject is **Reset your Kerf password (Westfield High)**. The link works once, for 30 minutes, and opens **Choose a password**. Saving the new password signs you in and signs you out on every other computer. Each address can get 3 of these emails per 15 minutes, and each computer can ask 20 times per 15 minutes; an address with accounts at several schools gets one email per school.
   - Staff who used to sign in with an emailed link have no password yet: they press **Forgot your password?** once.

8. **Make a group and add pupils.**
   - On **Classes**, press **New class…**. Fill in **Class code (optional)** (leave it blank and Kerf makes one) and **Note (optional)** (for example "Year 9 set 2", never a pupil's name). Press **Create**.
   - Press **Pupils…** on the new row (or open the class), then **Add pupils…**. Type one pupil per line: a name (for example `Zoë Adams`; Kerf makes a 5-digit pupil ID), an ID (for example a DINO ID), or `ID, Name`. Two columns pasted from a spreadsheet work too. You can also ask Kerf to **make N more pupils with no names**. Press **Add and make cards**.
   - Kerf gives every new pupil a **two-word password**, for example `tiger-river`. Their **Pupil Cards** open in a new tab, eight to an A4 page: the school name, the pupil's name (or "Pupil 23192"), **School code**, **Group code**, **Pupil ID**, **Password**, and where to sign in. Print them straight away: the passwords are not shown again. (If the browser blocks the new tab, allow pop-ups for the site.)
   - Lost a card? **New password…** on that pupil makes a new password and card. **New passwords and cards…** does it for the whole group. Old passwords stop working and the pupils are signed out. **Name…** sets or clears a pupil's name (shown to staff and printed on their card only).
   - **Pupils sign in** at `https://kerf.mr-salih.org/sign-in`, on the **I'm a pupil** tab, under **Use your Pupil Card**: they type the four things on their card and press **Sign in**, and the Editor opens. Capital letters and spaces instead of the dash in the password do not matter. Five wrong passwords lock that pupil ID for about 5 minutes. Pupil Card sign-in works only while **Group code** is ticked on the **School** page (it is, for a new school).
   - Pupils can also design without signing in: **Work without signing in** on the sign-in page opens the Editor, and the work stays in that browser.
   - **A pupil asks to join another group.** A signed-in pupil opens their menu (their name or ID, top right in the Editor) and chooses **Join a group…**. They type the group code the teacher shows them (for example `9B-DT`) and press **Ask to join**; the dialog says "Asked to join 9B-DT: waiting for your teacher" and lists their requests as **Waiting**, **Joined** or **Declined**. Only groups of their own school are found ("There is no group with the code … in your school."). A pupil can have up to 10 requests waiting.
   - **The teacher lets them in.** On **Classes**, the group shows "1 waiting to join" next to its pupil count (the **Pupils** page shows the school's total). **Pupils…** lists them under **Waiting to join**, by name if Kerf has one, otherwise "Pupil <ID>", with **Approve** and **Decline**. Approving adds the pupil to the group (making their Kerf account if they have none, or bringing back an archived pupil); a group already at the plan's 50-pupil limit says so and the request keeps waiting. Only the group's own teacher (or a school admin) sees and decides its requests.

9. **What the free plan includes.** Kerf's built-in default terms are:
   - features: the free tools only (no laser, no activities);
   - limits: 20 groups in a school, 50 pupils in a group and 20 files per pupil.

   A school keeps the copy it got when it was created, so later changes to the default do not affect it. Going over a limit gives, for example, "Your school's plan allows up to 20 groups in a school."

   The laser is a paid feature. It covers sending files, the queue and approval (where files are merged and reordered), the lasers, Station pages, the Cutter download and the camera. Activities and teacher feedback are also paid. A free school's terms can add either feature, or a time-limited grant such as a trial.

   **To move a school to paid**, the site admin goes to **Kerf Platform** → **Schools** and changes that school's **Plan** from **Free** to **Paid** (this is `PATCH /schools/{id} {"plan": "paid"}`). A paid school gets everything with no limits. To give a free school extras instead, use **Terms…** on its row (`PUT /schools/{id}/terms`). The **Default terms** page sets what new free schools get. There is no payment or billing in Kerf yet: the site admin does this by hand.

## Not built yet

- **Google and Microsoft sign-in**: the tick boxes exist but say "Coming soon". They also stay greyed out until Kerf is registered with Google and Microsoft.
- **Public pages**: the landing, pricing and sign-in pages are built. Things on them that do not work yet are greyed out and marked **Coming soon**: Google and Microsoft, prices, **Talk to us**, and the Privacy, Terms and Contact links.
- **Payment**: moving a school to paid is a manual switch for the site admin.

## If something goes wrong

- **"That link has expired or has already been used."** Invite links last 7 days, registration links 24 hours and reset links 30 minutes, and each works once (choosing a password also uses up the person's other links). Ask for a new link with **Forgot your password?** (step 7), or **Send me a new link** on the expired page. For an invite that was never used, ask an admin to press **Send again**. The same message appears for a link that was mistyped or cut short.
- **No email arrives.** Look in the junk or spam folder. The sender is `kerf-no-reply@mr-salih.org`. If you asked several times, wait 15 minutes, because only 3 links go to each address in that time. "Too many emails asked for from this computer. Wait a few minutes." means the computer's limit was reached. "Kerf could not send the email just now. Try again in a minute." means Resend refused the email or could not be reached.
- **"Email and password sign-in is switched off for your school…"** (`sign_in_off`): an admin has unticked **Email and password** on the **School** page. Forgot your password? then sends nothing, but still shows the usual "If that address has a Kerf account…" message.
- **Removed staff**: **Remove** signs the person out at once and cancels their unused links. They can no longer sign in (their password is removed), Forgot your password? sends nothing, and an old link gives the "expired or already been used" message. An admin can invite them again from **Staff**.
- **"Your sign-in is no longer valid. Sign in again."**: the session ended, either after about 10 hours, because the password was changed or reset on another computer, or because you were removed. Sign in again.
- **"Registration is closed"** on `/register`: the server has `KERF_REGISTRATION=false`. The site admin can still create the school (step 1, alternative).
- **`503 email_not_set_up`** when registering, creating a school or inviting someone: `KERF_PUBLIC_URL` is missing on the server (owner: see "Before you try this").
