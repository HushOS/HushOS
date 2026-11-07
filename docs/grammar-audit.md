# Interface grammar: audit of the web app

## Status

- Findings only. No UI has changed.
- Every finding waits for the owner's approval.
- A finding marked **Family** also needs that screen's own approval before it's built: desktop and phone, light and dark where it matters.

## What this checks

- The rules are in `DESIGN.md`, under Grammar: nouns, the verb matrix, layers, surface rules and attention.
- This document lists every web surface that breaks them.
- Every `Dialog`, `AlertDialog`, `Popover`, `DropdownMenu`, `ContextMenu`, `Sheet` and `toast.add` under `apps/web/src` was read against the rules.
- Out of scope: the operator console, the public site and the phone apps.

## How it was checked

- First audit: `e350a944` (main, 27 October 2026), 27 findings.
- This pass: `814f15bb` (main, 8 November 2026). Each finding, matrix cell and token was read again against the code.
- Nothing was run live. Every finding is read from the code.
- PR #338 (eyebrow labels) isn't merged, so the screens it touches were read as they are on main.

## What changed since 27 October

| Result       | Count | Which (first audit's numbers)                                                                                       |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------- |
| Fixed        | 4     | 1 Confirm with your bank, 5 link options over Share, 8 family Cancel and Resume, 26 danger for routine events       |
| Partly fixed | 2     | 3 Let them in (the three-step dialog is gone; a one-click charge is left), 7 toasts asking for a step (one is left) |
| Still open   | 21    | The rest, with new file and line references                                                                         |
| Dropped      | 0     | No finding's code is gone without its behaviour being fixed                                                         |
| Added        | 1     | Folder colour is a dialog with Save                                                                                 |

The findings are numbered again by rank. The first audit's number is under each title.

## Top ten

Ranked by what a person notices, how often, and what the change costs.

| #   | Noun              | Verb            | Today                                                                         | The rules call for                                                       | Family                  |
| --- | ----------------- | --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------- |
| 1   | Waiting to join   | Let in          | One click on the row buys a place when the family is full                     | A confirm whenever letting someone in charges for a place                | Yes                     |
| 2   | File, folder      | Rename          | Dialog                                                                        | Inline, in the row or tile, as Account's Name already is                 | Also in family folders  |
| 3   | File, folder      | Move            | The Move dialog closes with no toast; a drag gets a toast with Undo           | One ending: a toast with Undo either way                                 | Also in family folders  |
| 4   | Family            | Leave           | Under "Technical details and leaving"                                         | Last on the family page, in its own words, outside any disclosure        | Yes                     |
| 5   | Family            | (a failed wipe) | A toast says "Lock or sign out to clear them" and goes after 3.5 seconds      | An inline alert that stays until the step is done                        | Yes                     |
| 6   | Toast, bar, panel | (height)        | Toasts, the selection bar and the transfers panel use `xl`, a dialog's height | `lg` for all three; `xl` only for what stops the page                    | Shows on family screens |
| 7   | Place             | (naming)        | The Move dialog's heading "Places" lists My files and family folders          | One noun, one word: "places" stay the plan's room for people             | Yes                     |
| 8   | Member            | Remove          | After the confirm, a second dialog lists the removal's internal steps         | One dialog: the confirm's button says "Removing", then a toast           | Yes                     |
| 9   | This browser      | Lock            | Asks from the menu and from Account; locks at once from Sign out              | At once everywhere                                                       | No                      |
| 10  | Folder            | Colour          | A dialog with Save                                                            | A popover applied as each colour is chosen, as a tag's colour already is | Also in family folders  |

## Families

Every finding here needs the owner's approval for its screen.

### 1. Let them in can buy a place with one click

First audit: 3, partly fixed.

**Fixed since.** The three-step dialog is gone (#231).

- Let them in is the row's blue button, and acts at once with a toast ("Sam is in Lindqvist family").
- Not now sits beside it.
- Check it's Sam first is in the row menu.

**Today.**

- When every place is taken, a grey line under the row gives the price: "Letting Sam in adds one: $1.45 now, then…".
- One click on Let them in then charges the payer. Nothing asks.
- Not now asks "Turn Sam down?", and its button says "Turn down". The confirm doesn't repeat the verb.
- Where: `apps/web/src/components/families/members.tsx` 305–383 (`letThemIn`), 513–536 (the buttons), 579–601 (the confirm). The price line is `SeatNote`, `family-billing.tsx` 2068–2090.

**The rules call for.**

- Spending money is consequential, so it's a dialog.
- Let them in stays one click when it's free. When it buys a place, it asks once: "Let Sam in for $1.45 now?"
- Not now's confirm repeats the verb: "Not now for Sam?" with a Not now button. Or the row's button becomes Turn down.

**Cost or benefit.** Small. A payer never spends money from a button that looks like every other day's button.

**Test.** This touches billing, so CONTRIBUTING asks for a test beside it. A component test that a full family's Let them in asks before it calls the server would fail on this defect. Not added; say if you want it with the fix.

### 4. Leave family is inside Technical details

First audit: 6.

**Today.**

- Leave family sits in a folded section titled "Technical details and leaving".
- Where: `apps/web/src/components/families/family-page.tsx` 430–525.
- The confirm itself is right.

**The rules call for.**

- A noun's own destructive verb sits last on its page, labelled plainly.
- Technical details hold only what a layperson needn't see.

**Cost or benefit.** Small. People find the way out without opening a section that says it's technical.

### 8. Remove from family shows its internal steps in a dialog

First audit: 11.

**Today.**

- After the confirm (which is right), a second dialog lists the removal's steps: "Pausing Sam's changes", "Finishing an earlier key change", "Removing Sam".
- It can't be closed while it works.
- Where: `apps/web/src/components/families/remove-dialog.tsx` 50–55 (the steps), 179–256 (the dialog).

**The rules call for.**

- Work that goes on after a decision shows where its noun lives.
- The confirm's button reads "Removing" while it works. Then a toast, and the page's key-change line follows the rest.
- The dialog holds focus only as long as leaving the tab would break the removal.

**Cost or benefit.** Small to medium. One dialog instead of two, and no step names a layperson can't place.

### 11. Remove places at renewal is a dialog

First audit: 12.

**Today.**

- A dialog with a stepper. It's free and can be withdrawn (Keep 8 places).
- Where: `apps/web/src/components/families/family-billing.tsx` 1971–2060.

**The rules call for.** Reversible, with one value: an inline stepper in the Billing section, a toast, and Keep 8 places as its undo.

**Cost or benefit.** Small. One dialog fewer on the family page. Low priority.

### 12. Role changes ask even when they're undoable

First audit: 13.

**Today.**

- Let them manage, Stop them managing and Make them the organizer each open a confirm.
- Where: `apps/web/src/components/families/members.tsx` 1006–1063 (the menu), 1075–1093 (the confirm), 1347–1390 (`RoleConfirm`).

**The rules call for.**

- Let them manage gives someone power, and Make them the organizer hands over billing. Both keep their confirm.
- Stop them managing is undone by the manager who did it, so it acts at once with a toast.

**Cost or benefit.** Small. Low priority: each change signs a new member list, so an Undo is a second change, not a free one.

### 13. Create a family and New family folder are dialogs

First audit: 14.

**Today.**

- Both are a dialog with one name field.
- Where: `apps/web/src/components/families/create-family-dialog.tsx` (opened from `no-family.tsx` 78 and `routes/_authenticated/app/billing.tsx` 753) and `new-folder-dialog.tsx` (opened from `routes/_authenticated/app/_drive/s/$groupId/index.tsx` 71).

**The rules call for.** A new noun with only a name appears where it will live.

- New family folder: a new row on the family folders page, its name field focused.
- Create a family: the form on the no-family page, which is the family's home.

**Cost or benefit.** Medium for the folder row (finding 15 does it for both), small for the page form. Low priority.

## Drive

Folder views are shared with family folders (`FolderView` under `/app/s/<family>/f/<folder>`). Every Drive change below also shows there and needs that surface's approval.

### 2. Rename is a dialog

First audit: 2.

**Today.**

- Rename (menu, selection bar, F2) opens a dialog with one field.
- Where: `apps/web/src/components/drive/rename-dialog.tsx`, mounted in `folder-view.tsx` 1540 and `home-view.tsx` 698.
- Account's Name is already inline: `apps/web/src/routes/_authenticated/app/account.tsx` 248–358.

**The rules call for.**

- Inline, in the row or tile.
- Enter saves, Escape puts it back.
- A taken name or a refusal is said in a line under the field.

**Cost or benefit.** Medium: rows, grid tiles, Home and search each need the field. It's the commonest edit there is, and it stays where the eye already is.

### 3. Move from the dialog has no Undo

First audit: 4.

**Today.**

- The Move dialog just closes: a cue if Interface sounds are on, and no toast. `apps/web/src/components/drive/move-dialog.tsx` 131–155.
- A drag onto a folder gets a toast with Undo: `folder-view.tsx` 650–708.
- A drag onto a crumb gets a toast without Undo: `folder-view.tsx` 740–758.

**The rules call for.**

- One verb, one ending: every move within a place ends in "“Lisbon” moved to Photos" with Undo.
- A move to another place keeps its dialog, since it says what the move loses.

**Cost or benefit.** Small. People can trust Move the same way however they started it.

### 10. Folder colour is a dialog with Save

New in this pass.

**Today.**

- Colour, on a folder's menu or the selection bar, opens a dialog of swatches and a custom colour, with Save.
- Where: `apps/web/src/components/drive/folder-colour-dialog.tsx` 37–57, offered from `node-actions.tsx` 175–179, mounted in `folder-view.tsx` 1593.
- A tag's colour is already a popover applied as it's chosen: `tags-view.tsx` 219–243, `tag-colour.tsx` 351–385.

**The rules call for.**

- A choice from a few values: a popover anchored to Colour, applied as each colour is chosen.
- One noun pattern for colour, on folders and tags alike.

**Cost or benefit.** Medium. Each choice re-seals each folder's record, so applying as you go means a write per swatch, or a short debounce. That's the reason the code gives for Save. It's the same trade as finding 16.

### 14. Versions is a dialog

First audit: 15.

**Today.**

- Versions of “report.pdf” is a dialog. Restore is a button inside it.
- Delete the earlier version asks in a second dialog over it.
- Where: `apps/web/src/components/drive/versions-dialog.tsx` 84–90, 250–257 (Restore), 325–350 (the confirm).

**The rules call for.**

- Versions are about one file, beside the list: a section of Info on a wide window, a sheet on a narrow one.
- Restore acts at once with a toast. Restoring again swaps back.
- Delete the earlier version keeps its confirm.

**Cost or benefit.** Medium. One place for a file's facts and history. It also ends the last dialog over a dialog in Drive.

### 15. New folder is a dialog

First audit: 16.

**Today.**

- A dialog with one field. It also makes chains ("Reports/2026/Q3").
- Where: `apps/web/src/components/drive/create-folder-dialog.tsx`, mounted in `folder-view.tsx` 1538 and `home-view.tsx` 691.

**The rules call for.** A new row in the list, its name field focused, chains included.

**Cost or benefit.** Medium, and it shares the inline field with finding 2. Low priority: a dialog for New folder is common elsewhere, but the rules make no exception for it.

### 16. Tags on items is a dialog with Save

First audit: 17.

**Today.**

- Tags for “report.pdf” is a dialog listing every tag as on, some or off, with Save tags.
- Where: `apps/web/src/components/drive/tag-dialog.tsx` 192, 316.

**The rules call for.** A choice among a few values: a popover anchored to Tags, applied as each tag is chosen, with a new tag made in its field.

**Cost or benefit.** Medium: each change re-seals the item's metadata, so a write per tag, or a short debounce. It's lighter for the common case of one tag on one item.

### 17. Info on a narrow window is a centred dialog

First audit: 18.

**Today.**

- Below 1024px, Info is a dialog.
- Where: `apps/web/src/components/drive/info-dialog.tsx`; the width check is `useWideScreen`, `node-actions.tsx` 50–60.

**The rules call for.** A panel without room becomes a sheet from an edge: the bottom on a phone, the right on a tablet.

**Cost or benefit.** Small, with the existing `Sheet`. Low priority.

### 18. Copy link confirms twice

First audit: 19.

**Today.**

- The button turns to "Copied", and a toast says "Link copied" with what the link allows.
- Where: `apps/web/src/components/drive/share-dialog.tsx` 1063–1078, 1157.

**The rules call for.**

- Confirm once, where it happened: the button's word.
- The toast only where the button goes away.
- Who can open it is already said on the row.

**Cost or benefit.** Tiny. Low priority.

### 19. The Share dialog is titled "Who can open this?"

First audit: 20.

**Today.**

- `apps/web/src/components/drive/share-dialog.tsx` 471.
- DESIGN.md, under Components, says the sheet is "Share" on every client.

**The rules call for.**

- A surface opened by a verb is titled by that verb.
- Either retitle it Share, or change DESIGN.md. The phones must match whichever is kept.

**Cost or benefit.** Tiny. The owner's call on the words.

## Contacts

### 20. Add someone and Remove (conflicts with optional verification)

First audit: 21, changed.

**Fixed since.** Add someone no longer asks for twelve words (#222). It's one email field, and the person is a contact at once.

**Today.**

- Add someone is still a dialog: `apps/web/src/routes/_authenticated/app/_drive/contacts.tsx` 136–141, `components/drive/add-someone.tsx`.
- Remove asks once: `contacts.tsx` 317–345.

**The rules call for.**

- Adding is one field that makes a noun, which the rules put inline: a field at the top of Contacts, as Share's people field already is.
- Remove is undone by adding again with nothing lost, so it acts at once with Undo.

**Conflict.** `docs/optional-verification.md` 6.2 and 6.5 specify a dialog for Add someone and a confirm for Remove.

- Either the rules gain an exception for a lookup that can fail, or 6.2 and 6.5 change.
- The owner's call. Nothing should be built until it's made.

## Account

### 9. Lock asks from the menu and Account, and not from Sign out

First audit: 23.

**Today.**

- The account menu's Lock on this browser, and Account's button of the same name, ask "Lock HushOS on this browser?"
- Where: `apps/web/src/components/device-control.tsx` 79–100; opened from `user-menu.tsx` 143–150 and `routes/_authenticated/app/account.tsx` 417–423.
- Lock instead, inside the Sign out confirm, locks at once: `user-menu.tsx` 219–232.

**The rules call for.**

- Lock is undone by typing the password, so it acts at once everywhere.
- The menu item's hint can say uploads pause.

**Cost or benefit.** Small. One dialog fewer, and one verb that behaves one way.

### 21. Renames of a device, a tag and a family are dialogs

First audit: 22, now with Rename family too.

**Today.** Each is a one-field dialog, beside Account's inline Name.

- Rename device: `apps/web/src/components/account-devices.tsx` 210–300.
- Rename tag: `apps/web/src/components/drive/tag-view.tsx` 348–436, also opened from `tags-view.tsx` 263.
- Rename family (**Family**): `apps/web/src/components/families/rename-dialog.tsx`, opened from the page title in `family-page.tsx` 230–235.

**The rules call for.** Inline, as Name.

**Cost or benefit.** Small each. Four renames that behave like one.

### 22. Cancelling a plan asks why inside the decision

First audit: 24, now on the family plan too.

**Today.**

- Cancel Plus? holds a reason select and a note under the description: `apps/web/src/routes/_authenticated/app/billing.tsx` 963–1029.
- The family's Cancel the plan for Lindqvist family? now does the same (**Family**): `apps/web/src/components/families/family-billing.tsx` 1254–1321.

**The rules call for.**

- A dialog asks one question.
- The reason can follow, inline on the page, once the plan is set to end.

**Cost or benefit.** Small. Low priority: it may cost some answers, so it's the owner's call.

## Everywhere

### 5. A toast that asks for a step

First audit: 7, partly fixed.

**Fixed since.** The Unverified mark no longer ends its checks in toasts that send you to Contacts. A changed account opens the check itself.

**Today (Family).**

- A leave that couldn't clear the device says "Lock or sign out to clear them." in an error toast that goes after 3.5 seconds.
- Where: `apps/web/src/components/families/family-page.tsx` 620–627.

**The rules call for.**

- A toast confirms. Anything that needs doing is an inline alert that stays until it's done.
- Here: on Drive (or Account), after the leave.

**Cost or benefit.** Small. The one instruction that protects the device no longer vanishes before it's read.

### 6. Three things that don't stop the page use a dialog's `xl`

First audit: 9.

**Today.**

- Toasts: `apps/web/src/components/ui/toast.tsx` 45.
- The selection bar: `apps/web/src/components/drive/file-list.tsx` 563.
- The transfers panel: `apps/web/src/components/drive/transfers-panel.tsx` 471.
- All three use `shadow-xl`. DESIGN.md gives toasts and bars `lg`, and panels `md`.
- The other way round: the `Sheet` primitive sits over the scrim but uses `shadow-overlay` (`lg`), a `rule` hairline and no corners: `apps/web/src/components/ui/sheet.tsx` 54. The rules give it `xl`, `edge` and `sheet` corners on its free side.

**The rules call for.**

- `lg` for toasts and bars; `md` for the transfers panel.
- `xl` only for dialogs and sheets.

**Cost or benefit.** Tiny: class swaps. Height means one thing again: `xl` is the height that asks for an answer. The toast change shows on family screens too.

### 7. "Places" names two things

First audit: 10.

**Today.**

- The Move dialog's heading "Places" lists My files and each family's folders.
- Its note says "Moving to another place…".
- Where: `apps/web/src/components/drive/move-dialog.tsx` 201, 209, 326.
- Billing's places are a plan's room for people (Add places, "4 of 8 places taken").

**The rules call for.**

- One noun, one word.
- The Move dialog says "My files and family folders" (or no heading), and "Moving to the family folders…" in the note.

**Cost or benefit.** Tiny. Nobody reads "Add places" and wonders whether it means folders. The Move dialog lists family folders, so it needs the family approval.

### 23. Loading rows pulse

First audit: 25.

**Today.** These use `animate-pulse`:

- `Skeleton`: `apps/web/src/components/ui/skeleton.tsx` 7.
- The file list's loading rows: `apps/web/src/components/drive/file-list.tsx` 765–767.
- The storage card's placeholder: `apps/web/src/components/storage-card.tsx` 89.

**The rules call for.** Nothing pulses. Loading rows are still, as the drive's "Opening your files" line already is.

**Cost or benefit.** Tiny. Shows on family pages too.

### 24. Raised surfaces mix hairlines and corners

First audit: 27.

**Today.**

- Menus, popovers, selects, tooltips and the context menu draw `border-border`, which is `rule`: `dropdown-menu.tsx` 39 and 139, `popover.tsx` 37, `select.tsx` 77, `tooltip.tsx` 40, `context-menu.tsx` 45 (all in `apps/web/src/components/ui`).
- Dialogs and the transfers panel draw `edge`.
- Info's panel has `sheet` corners (20, `rounded-2xl`): `apps/web/src/components/drive/details-panel.tsx` 655. DESIGN.md gives a panel `card` corners (16).
- The `sheet` utility (`apps/web/src/styles.css` 500) is the viewer's page of a document, with chip corners. It shares its name with the Sheet layer.

**The rules call for.**

- `edge` on everything raised; `rule` inside the page.
- The panel's corners from the scale its layer names.
- The viewer's utility renamed (`paper`), so "sheet" names one layer.

**Cost or benefit.** Tiny. In high contrast, where the hairline carries height alone, menus and dialogs then draw the same line.

## Fixed since the first audit

These now follow the rules. Each is also in the next list.

- **Confirm with your bank stays** (first audit: 1; #214, #291). The Add places and Change plan dialogs stay mounted while open and keep the summary they were quoted from, so a raise that fills the family no longer takes the bank step away. The page offers Confirm with your bank until the bank confirms.
- **A link's password and end date** (first audit: 5). They take the Share dialog's place, and closing them comes back. No dialog over Share.
- **Cancel and Resume for the family plan** (first audit: 8; #202). Cancel is decided in HushOS, in one dialog, and Resume plan acts at once, as on the personal plan. The reason the cancel asks for is finding 22.
- **Danger for routine events** (first audit: 26). The Unverified mark and the family's fork alert use `warning`, not danger. Contacts says Verified or Not verified in muted text, with no Check again badge.

## What already follows the rules

These keep their surface, so the rules aren't read as a list of everything wrong.

### Drive

- Move to Trash acts at once with Undo, for one item or a selection. Restore acts at once from Trash.
- Delete forever, Empty Trash, Delete family folder, Delete the earlier version and Remove earlier versions each ask once, and the confirm repeats the verb.
- Share is a dialog, because it gives access.
- Inside Share, Stop sharing, Turn off link, a link's password and end date, and Check it's Maya each take the dialog's place. One dialog at a time.
- Info's contact checks take its place too, on a narrow window.
- A tag's colour is a popover, applied as it's chosen. New tag is inline on Tags.
- A name that's taken on upload, and an upload with no room, interrupt only because of the person's own drop. They must be answered before the upload goes on.
- The viewer is a page with its own URL (`?preview=`), not a dialog over the list.

### People and families

- Account's Name is inline.
- Check it's them and Your twelve words are dialogs: reading words aloud holds focus.
- Let them in is one click on the row when it's free, with a toast (see finding 1 for when it isn't).
- Invite someone is a dialog, because an email can't be unsent. Cancel invitation asks once.
- Leave family and Remove from family ask once before anything happens.
- The family page's notices are inline alerts that arrive once. The sidebar has no badges or dots.

### Plans and account

- Choosing a family plan goes straight to Polar's checkout. It asks first only when it ends a plan whose payment failed.
- Switch to Pro? asks before a personal plan changes.
- Add places and Change plan are dialogs, because they spend money, and they hold the bank step.
- Keep Family Pro, Keep 8 places and Resume plan act at once, on both plans.
- Change password, Make a new phrase, Replace sharing keys, Rotate account key and Delete account are dialogs.
- Sign out and Remove device ask once.
