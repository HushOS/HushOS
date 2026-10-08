# Proposed features

What the Alpine design board (`apps/design`, removed after the redesign; it is in git history up to the commit that removed it) drew as proposed but nobody has built. Each entry says what it is, what the board decided about its shape and words, and what is open. None of it may be claimed anywhere in the product until it ships.

## Being built on the redesign branch

- Account recovery in the phone apps (9), transfer notifications (3) and Save to HushOS from other apps (4).

## Waiting for a decision

### 1. Create an account in the phone apps

A welcome screen with Create account and Sign in. The steps and words are the web's: email, the verification link (which opens the app through its app links), name and password, then the recovery phrase with Save the kit and a check of three words. Today the apps open on sign in and send new people to the web.

Open: the web's consent checkboxes and plan choice need a phone form; the verification link must open the app on the phone that asked and the web anywhere else.

### 2. Invite by email

Sharing with someone who has no HushOS account: they get an email, create an account, and the share completes once their keys exist. People already on HushOS are added at once, with "Check it's them" as a quiet later step in People you share with.

Open: the share has to wait, sealed, for keys that don't exist yet, so the server holds an invitation, not a share; the sharer still checks the twelve words afterwards. Today adding by email only finds existing accounts and no email is sent.

### 3. Transfer notifications

A notification when an upload or a keep finishes or doesn't, while the app is in the background. Android only: on iOS the Live Activity already carries both outcomes.

### 4. Save to HushOS from other apps

An iOS share extension and an Android share target, so a photo, a scan or a Mail attachment goes into a chosen folder from any app. Uploads run on the normal background queue with the Live Activity or the notification.

Open: the extension needs the vault (keys, upload sealing) outside the app process, through the app group on iOS.

### 5. Home screen widgets

Recent and Storage, on both platforms.

Open: file names on the home screen show what is private to anyone holding the phone; Storage alone may be the only widget worth having.

### 6. Family plan

One bill and a private drive for each person in the household. Pricing shows it as a "coming soon" line with no price and no button.

Open: seats and invitations in Polar billing; shares most of its work with the team plan.

### 7. Team plan

One bill for the whole team, folders that belong to the team rather than to whoever made them, and one place to add and remove people. The pricing page's Business tab and the For teams page show it as "coming soon", with what teams can do today beside it and "Talk to us".

Open: a new kind of workspace, admin roles, and handing over keys when someone leaves.

### 8. Desktop apps

Listed under "Coming soon" on the For teams page. There is no plan behind it yet.

### 9. Account recovery in the phone apps

After the same email step: Scan your kit (the printed QR code), Choose the kit file, or Type the 24 words, in that order. Today the apps hand off to the web.

## Later, not on this branch

- **Create an account in the phone apps (1)** and **invite by email (2).** Later.
- **Team plan (7).** Comes later on its own branch. Until then the Business tab and the For teams page keep "coming soon" and Talk to us.
- **Desktop apps (8).** Later.

## Decided: not planned

- **Home screen widgets (5).** Dropped.
- **Family plan (6).** Dropped; the "coming soon" line is gone from pricing.

- **Photos tab and photo backup.** Upload photos and Take photo stay on both phones.
- **Android in-app viewer.** Files open in the default app.
