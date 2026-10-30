# Interface grammar: audit of the web app

Status: findings only. No UI has changed. Each finding waits for the owner's approval, and every finding marked **Family** also needs that screen's own approval before it is built (desktop and phone, light and dark where it matters).

The rules are in `DESIGN.md`, under Grammar: the nouns, the object-action matrix, the layers, the surface rules and attention. This document lists every web surface that breaks them, read from the code at `e350a944` (main, 27 October 2026). Every `Dialog`, `AlertDialog`, `Popover`, `DropdownMenu`, `ContextMenu`, `Sheet` and `toast.add` under `apps/web/src` was read against the rules. Nothing was run live: finding 1 is read from the code and not reproduced against the Polar sandbox (how to reproduce is under it). The operator console, the public site and the phone apps are out of scope.

## Top ten, ranked

Ranked by what a person notices, how often, and what the change costs. The numbers are ranks; below, the findings are grouped by area, and those past ten are ranked too.

| #   | Noun               | Verb                    | Today                                                                                         | The rules call for                                                                                  | Family                          |
| --- | ------------------ | ----------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Family plan, place | Change plan, Add places | "Confirm with your bank" lives in a dialog that can unmount once the charge is made           | The dialog stays until it's closed; the page offers Confirm with your bank until the bank confirms  | Yes                             |
| 2   | File, folder       | Rename                  | Dialog                                                                                        | Inline, in the row or tile, as Account's Name already is                                            | Also in family folders          |
| 3   | Waiting to join    | Let in, Not now         | A three-step dialog; Not now only inside it                                                   | Let them in and Not now on the row; a dialog only when letting in charges for a place               | Yes                             |
| 4   | File, folder       | Move                    | The Move dialog closes with no toast; a drag gets a toast with Undo                           | One verb, one ending: a toast with Undo either way                                                  | Also in family folders          |
| 5   | Link               | Password and end date   | A dialog over the Share dialog                                                                | An inline section in the link's row, as Show as QR code already is                                  | No                              |
| 6   | Family             | Leave                   | Under "Technical details and leaving"                                                         | Last on the family page, in its own words, outside any disclosure                                   | Yes                             |
| 7   | Family, contact    | (failures and checks)   | Toasts that ask for a step ("Lock or sign out to clear them", "Check it’s them in Contacts.") | An inline alert that stays until the step is done                                                   | Partly                          |
| 8   | Family plan        | Cancel, Resume          | Cancel is a confirm whose button opens the portal; Resume is only in the portal               | Like the personal plan: one decision where it's made, Resume at once; or a plain link to the portal | Yes                             |
| 9   | Toast, bar, panel  | (height)                | Toasts, the selection bar and the transfers panel use `xl`, the dialog's height               | `lg` for all three; `xl` only for what stops the page                                               | Shows on family screens         |
| 10  | Place              | (naming)                | The Move dialog's heading "Places" lists My files and family folders                          | One noun, one word: "places" stay the plan's room for people                                        | Yes (Move lists family folders) |

## Families

Every finding here needs the owner's approval for its screen.

### 1. Confirm with your bank can disappear (Change plan, Add places)

- **Today.** `PlanSection` mounts each dialog only while its verb is offered: `{actions.addPlaces && <AddPlacesDialog …/>}` and `{actions.changePlan && <ChangePlanDialog …/>}` (`apps/web/src/components/families/family-billing.tsx` 1069–1092), and each dialog returns `null` when its own range or moves are empty (1201, 1322). After the charge, `onDone(result.billing)` (1213, 1343) hands the page the new summary before `setConfirmUrl(result.url)` keeps the bank's link. If that summary withdraws the verb, the dialog unmounts and its link goes with it: Change plan is withdrawn while an upgrade waits for the bank or paid places trail the places (`apps/web/src/lib/family-billing.ts` 456–459), and Add places once the family reaches 20 (`addRange`, 220). The page then says to confirm "in Manage payment and invoices", a different route from the one the dialog held.
- **The rules call for.** A dialog belongs to whoever opened it, and a step that must hold focus is never taken away. Mount the dialogs on their open state, keep the summary each opened with, and lift the bank's link to the Billing section, so the page shows Confirm with your bank until the charge is confirmed.
- **Cost or benefit.** Small. A payer can always finish a charge their bank is holding, which is the one moment money is in the air.
- **To reproduce.** In the Polar sandbox, with a card that asks for 3-D Secure: add places up to 20, or change to a bigger tier, and watch the dialog after the charge.
- **Test.** This is billing code, so CONTRIBUTING asks for a test beside it: a component test that the dialog and its bank link survive a summary that withdraws the verb would fail on this defect. Not added; say if you want it with the fix.

### 3. Let them in is a three-step dialog

- **Today.** The row's Let them in opens a dialog with three steps: compare Sam's twelve words, let them in, compare the join code (`apps/web/src/components/families/let-in-dialog.tsx`, opened from `members.tsx` 185–205). Not now is only inside that dialog, behind a second confirm (`let-in-dialog.tsx` 596–640).
- **The rules call for.** Let them in is consequential but undone by Remove, so it acts from the row with a toast ("Sam is in Lindqvist family"). It becomes a dialog only when it spends money ("Every place is taken. Letting Sam in adds one: $1.45 now…"). Not now sits beside it as an outline button and asks once. Checking moves to the row menu as Check it's Sam. This is `docs/optional-verification.md` 6.8, which the rules now explain.
- **Cost or benefit.** Large, and tied to the optional-verification build plan (section 8); the rules add only the case for the charge. It removes the flow the owner called "really complicated".

### 6. Leave family is inside Technical details

- **Today.** Leave family sits in a `<details>` titled "Technical details and leaving" (`apps/web/src/components/families/family-page.tsx` 351–415). The confirm itself is right.
- **The rules call for.** A noun's own destructive verb sits last on its page, labelled plainly. Technical details hold only what a layperson needn't see.
- **Cost or benefit.** Small. People find the way out without opening a section that says it's technical, and Technical details hold only technical things again.

### 8. Cancel and Resume work differently for the family plan

- **Today.** The family's Cancel plan opens a confirm whose action is "Cancel in the billing portal" (`family-billing.tsx` 1093–1115): the dialog asks, then the real decision is made again at Polar. Resume exists only in the portal ("Resume in portal", 542; "resume it in Manage payment and invoices", 468). The personal plan cancels in HushOS in a dialog (`apps/web/src/routes/_authenticated/app/billing.tsx` 960–1030) and resumes at once with Resume plan (548–556).
- **The rules call for.** One noun, the same verbs on the same surfaces. Either cancel and resume in HushOS as the personal plan does, or make Cancel a plain link that says where it goes ("Cancel in the billing portal") with no dialog in front of it.
- **Cost or benefit.** The link is a small change. Cancel and resume in HushOS need group billing routes, which is a medium-sized server change. Either way the second "are you sure" goes.

### 11. Remove from family shows its internal steps in a dialog

- **Today.** After the confirm (right as it is), a second dialog lists the removal's steps ("Pausing Sam’s changes", "Finishing an earlier key change", "Removing Sam") and can't be closed while it works (`apps/web/src/components/families/remove-dialog.tsx` 50–55, 175 on).
- **The rules call for.** Work that goes on after a decision shows where its noun lives. The confirm's button reads "Removing" while it works; then a toast, and the page's key-change line follows the rest. The dialog holds focus only for as long as leaving the tab would break the removal.
- **Cost or benefit.** Small to medium. One dialog instead of two, and none of the step names a layperson can't place.

### 12. Remove places at renewal is a dialog

- **Today.** A dialog with a stepper (`family-billing.tsx` 1511–1597). It's free and withdrawable (Keep 8 places).
- **The rules call for.** Reversible, with one value: an inline stepper in the Billing section with a toast, and Keep 8 places as its undo.
- **Cost or benefit.** Small. One dialog less on the family page; low priority.

### 13. Role changes ask even when they're undoable

- **Today.** Let them manage, Stop them managing and Make them the organizer each open a confirm (`apps/web/src/components/families/members.tsx` 429–445, 481–525).
- **The rules call for.** Let them manage gives someone power and Make them the organizer hands over billing, so both keep their confirm (and 6.9 of optional-verification puts a check before the first). Stop them managing is undone by the manager who did it: at once, with a toast.
- **Cost or benefit.** Small. Low priority; each change signs a new member list, so an Undo would be a second change, not a free one.

### 14. Create a family and New family folder are dialogs

- **Today.** Both are a dialog with one name field (`apps/web/src/components/families/create-family-dialog.tsx`, `new-folder-dialog.tsx`).
- **The rules call for.** A new noun with only a name appears where it will live: New family folder as a new row on the family folders page with its name field focused; Create a family as the form on the no-family page, which is the family's home.
- **Cost or benefit.** Medium for the folder row (the Drive change in finding 16 does it for both), small for the page form. Low priority.

## Drive

Folder views are shared with family folders (`FolderView` under `/app/s/<family>/f/<folder>`), so every Drive change below also shows in family folders and needs that surface's approval there.

### 2. Rename is a dialog

- **Today.** Rename (menu, selection bar, F2) opens a dialog with one field (`apps/web/src/components/drive/rename-dialog.tsx`, mounted in `folder-view.tsx` 1462 and Home). Account's Name is already inline (`apps/web/src/routes/_authenticated/app/account.tsx` 249 on).
- **The rules call for.** Inline in the row or tile: Enter saves, Escape puts it back, a taken name or a refusal is said in a line under the field.
- **Cost or benefit.** Medium: rows, grid tiles, Home and search each need the field, and the taken-name check moves inline. It's the commonest edit there is, and it stays where the eye already is.

### 4. Move from the dialog has no Undo

- **Today.** The Move dialog just closes, with a cue if Interface sounds are on and no toast (`apps/web/src/components/drive/move-dialog.tsx` 131–155). A drag onto a folder gets a toast with Undo (`folder-view.tsx` 634–690); a drag onto a crumb gets a toast without one (715–736).
- **The rules call for.** One verb, one ending: every move within a place ends in "“Lisbon” moved to Photos" with Undo. A move to another place keeps its dialog, since it says what the move loses.
- **Cost or benefit.** Small. People can trust Move the same way however they started it.

### 5. A link's password and end date open a dialog over Share

- **Today.** `LinkOptionsDialog` (`apps/web/src/components/drive/link-row.tsx` 60–230) opens over the Share dialog (`share-dialog.tsx` 898). Show as QR code, in the same row menu, already opens inline.
- **The rules call for.** One dialog at a time, except an irreversible confirm. Password and end date open as an inline section in the link's row, saved with its own button.
- **Cost or benefit.** Small to medium. No dialog over a dialog, and the link's settings sit beside the link they change.

### 15. Versions is a dialog

- **Today.** Versions of “report.pdf” is a dialog; Restore is an icon button inside it, and Delete the earlier version asks over it (`apps/web/src/components/drive/versions-dialog.tsx`).
- **The rules call for.** Versions are about one file, beside the list: a section of Info on a wide window (a sheet on a narrow one). Restore acts at once with a toast (restoring again swaps back); Delete the earlier version keeps its confirm.
- **Cost or benefit.** Medium. One place for a file's facts and history, and the delete confirm no longer stacks on a dialog.

### 16. New folder is a dialog

- **Today.** A dialog with one field, which also makes chains ("Reports/2026/Q3") (`apps/web/src/components/drive/create-folder-dialog.tsx`).
- **The rules call for.** A new row in the list with its name field focused, chains included.
- **Cost or benefit.** Medium, and it shares the inline field with finding 2. Low priority: a dialog for New folder is common elsewhere, but the rules don't make an exception for it.

### 17. Tags on items is a dialog with Save

- **Today.** Tags for “report.pdf” is a dialog listing every tag as on, some or off, with Save (`apps/web/src/components/drive/tag-dialog.tsx`).
- **The rules call for.** A choice among a few values: a popover anchored to Tags, applied as each tag is chosen, with a new tag made in its field.
- **Cost or benefit.** Medium: each change re-seals the item's metadata, so applying as you go means a write per tag, or a short debounce. It's lighter for the common case of one tag on one item.

### 18. Info on a narrow window is a centred dialog

- **Today.** Below 1024px Info is a dialog (`apps/web/src/components/drive/info-dialog.tsx`, `useWideScreen` in `node-actions.tsx`).
- **The rules call for.** A panel without room becomes a sheet from an edge: the bottom on a phone, the right on a tablet.
- **Cost or benefit.** Small with the existing `Sheet`. Low priority.

### 19. Copy link confirms twice

- **Today.** The button turns to "Copied" and a toast says "Link copied" with what the link allows (`share-dialog.tsx` 728–752).
- **The rules call for.** Confirm once, where it happened: the button's word, and the toast only where the button goes away. The sentence about who can open it belongs on the row, where it already is.
- **Cost or benefit.** Tiny. Low priority.

### 20. The Share dialog is titled "Who can open this?"

- **Today.** `share-dialog.tsx` 239. DESIGN.md says the sheet is "Share" on every client.
- **The rules call for.** A surface opened by a verb is titled by that verb. Either retitle it Share or change DESIGN.md; the phones must match whichever is kept.
- **Cost or benefit.** Tiny. Owner's call on the words.

## Contacts

### 21. Add someone and Remove (conflicts with optional verification)

- **Today.** Add someone is a dialog that looks the person up and then asks for their twelve words (`apps/web/src/routes/_authenticated/app/_drive/contacts.tsx` 309–325, `check-contact.tsx`). Remove asks once (389 on).
- **The rules call for.** Once the words are optional, adding is one field that makes a noun, which the rules put inline (a field at the top of Contacts, as Share's people field already does). Remove is undone by adding again with nothing lost, so it acts at once with Undo.
- **Conflict.** `docs/optional-verification.md` 6.2 and 6.5 specify a dialog for Add someone and a confirm for Remove. Either the rules gain an exception for a lookup that can fail, or 6.2 and 6.5 change. Owner's call; nothing should be built until it's made.

## Account

### 22. Rename device and Rename tag are dialogs

- **Today.** Rename device (`apps/web/src/components/account-devices.tsx` 210–300) and Rename tag (`apps/web/src/components/drive/tag-view.tsx` 394) are one-field dialogs, beside Account's inline Name.
- **The rules call for.** Inline, as Name.
- **Cost or benefit.** Small each. Three renames that behave like one.

### 23. Lock asks from the menu and not from Sign out

- **Today.** The account menu's Lock asks "Lock HushOS on this browser?" (`apps/web/src/components/device-control.tsx` 82–100). The Lock button inside the Sign out confirm locks at once (`apps/web/src/components/user-menu.tsx` 240–250).
- **The rules call for.** Lock is undone by typing the password, so it acts at once everywhere; the menu item's hint can say uploads pause.
- **Cost or benefit.** Small. One dialog less, and one verb that behaves one way.

### 24. Cancelling a personal plan asks why inside the decision

- **Today.** Cancel Plus? holds a reason select and a note under the description (`billing.tsx` 966–1030).
- **The rules call for.** A dialog asks one question. The reason can follow, inline on the page, once the plan is set to end.
- **Cost or benefit.** Small. Low priority; it may cost some answers, so it's the owner's call.

## Everywhere

### 7. Toasts that ask for a step

- **Today.** A leave that couldn't clear the device says "Lock or sign out to clear them." in an error toast that goes after 3.5 seconds (`family-page.tsx` 501–506; **Family**). The Unverified mark's checks end in toasts saying "Check it’s them in Contacts." and "Compare words with them again in Contacts." (`apps/web/src/components/drive/unverified-mark.tsx` 160–190).
- **The rules call for.** A toast confirms; anything that needs doing is an inline alert that stays until it's done: on Drive (or Account) after the leave, and in the Unverified popover or Info for the checks.
- **Cost or benefit.** Small. The one instruction that protects the device no longer vanishes before it's read.

### 9. Height: three things that don't stop the page use the dialog's `xl`

- **Today.** Toasts (`apps/web/src/components/ui/toast.tsx` 43), the selection bar (`apps/web/src/components/drive/file-list.tsx` 506) and the transfers panel (`transfers-panel.tsx` 484) use `shadow-xl`; DESIGN.md's Elevation & Depth gives toasts and selection bars `lg`. The `Sheet` primitive, which sits over the scrim, uses `shadow-overlay` (`lg`) where the rules give it `xl` (`apps/web/src/components/ui/sheet.tsx` 54).
- **The rules call for.** `lg` for toasts, bars and the transfers panel (`md` if it's read as a panel); `xl` only for dialogs and sheets.
- **Cost or benefit.** Tiny, class swaps. Height means one thing again: `xl` is the height that asks for an answer. The toast change shows on family screens too.

### 10. "Places" names two things

- **Today.** The Move dialog's heading "Places" lists My files and each family's folders, and its note says "Moving to another place…" (`move-dialog.tsx` 201, 209). Billing's places are a plan's room for people (Add places, "4 of 8 taken").
- **The rules call for.** One noun, one word. The Move dialog says "My files and family folders" (or no heading), and "Moving to the family folders…" in the note.
- **Cost or benefit.** Tiny. No one reads "Add places" and wonders whether it means folders. The Move dialog lists family folders, so it needs the family approval.

### 25. Loading rows pulse

- **Today.** `Skeleton` (`apps/web/src/components/ui/skeleton.tsx` 7), the file list's loading rows (`file-list.tsx` 708–710) and the storage card's placeholder (`storage-card.tsx` 89) use `animate-pulse`.
- **The rules call for.** Nothing pulses. Loading rows are still, as the drive's "Opening your files" line already is.
- **Cost or benefit.** Tiny. Shows on family pages too.

### 26. Danger and warning used for routine events

- **Today.** A key conflict turns the Unverified mark red (`unverified-mark.tsx` 215–220); the family's ForkAlert is `destructive` (`apps/web/src/components/families/family-alerts.tsx` 35; **Family**); Contacts shows a `warning` badge "Check again" (`contacts.tsx` 259).
- **The rules call for.** Danger only for something that will be lost; status colours only with words, in inline alerts. Optional verification (6.5, 6.11, 6.12) already moves all three to calm wording in `warning` or muted text; the rules give the reason.
- **Cost or benefit.** Small, and planned. Listed so the rule and the plan agree.

### 27. Raised surfaces mix hairlines and corners

- **Today.** Menus, popovers and tooltips draw `border-border`, which is `rule` (`dropdown-menu.tsx` 39, `popover.tsx` 37, `tooltip.tsx` 40); dialogs and the transfers panel draw `edge`. Info's panel has `sheet` corners (20, `rounded-2xl`, `details-panel.tsx` 646) where DESIGN.md gives it `card` (16). The `sheet` utility (`styles.css`) is the viewer's page of a document, with chip corners, and shares its name with the Sheet layer. DESIGN.md gives the page panel `sm`; the web draws a `rule` hairline and no shadow.
- **The rules call for.** `edge` on everything raised, `rule` inside the page; the panel's corners from the scale its layer names; the viewer's utility renamed (`paper`) so "sheet" names one layer. For the page panel, either the hairline goes into Elevation & Depth or the panel gets `sm`.
- **Cost or benefit.** Tiny. In high contrast, where the hairline carries height alone, menus and dialogs then draw the same line.

## What already follows the rules

So the rules aren't read as a list of everything wrong: these keep their surface.

- Move to Trash acts at once with Undo, for one item or a selection; Restore acts at once from Trash.
- Delete forever, Empty Trash, Delete family folder, Delete the earlier version and Remove earlier versions each ask once, and the confirm repeats the verb.
- Account's Name is inline.
- Share is a dialog (it gives access), and Stop sharing and Turn off link ask on top of it, the one stacking the rules allow.
- Check it's them and Your twelve words are dialogs: reading words aloud holds focus.
- Invite someone is a dialog (an email can't be unsent); Cancel invitation asks once.
- Leave family and Remove from family ask once before anything happens.
- Choosing a family plan goes straight to Polar's checkout, and asks first only when it ends a plan whose payment failed; Switch to Pro? asks before a personal plan changes.
- Keep Family Pro, Keep 8 places and Resume plan act at once.
- Change password, Make a new phrase, Replace sharing keys, Rotate account key and Delete account are dialogs; Sign out and Remove device ask once.
- A name that's taken on upload, and an upload with no room, interrupt only because of the person's own drop, and must be answered before the upload goes on.
- The viewer is a page with its own URL (`?preview=`), not a dialog over the list.
- The family page's notices are inline alerts that arrive once; the sidebar has no badges or dots.
