# Changelog

## [0.11.0](https://github.com/HushOS/HushOS/compare/v0.10.0...v0.11.0) (2026-10-30)


### Features

* **android:** adapt the app to foldables and large screens ([#234](https://github.com/HushOS/HushOS/issues/234)) ([fc04537](https://github.com/HushOS/HushOS/commit/fc0453701c4f261aa40a614727cc48124fb86c8d))
* **crypto:** accept a family on first use and check it later ([#207](https://github.com/HushOS/HushOS/issues/207)) ([d57831a](https://github.com/HushOS/HushOS/commit/d57831a70c0eeb27bff4030c77f02c96f9d8180a))
* **crypto:** keep a first-seen pin for people nobody has checked ([#206](https://github.com/HushOS/HushOS/issues/206)) ([d78682b](https://github.com/HushOS/HushOS/commit/d78682b317054dc5d87c8ad2de514837ddc0708d))
* **crypto:** keep a node's attributes when a client re-saves it ([#226](https://github.com/HushOS/HushOS/issues/226)) ([d389f2a](https://github.com/HushOS/HushOS/commit/d389f2aa474a6ecff7190e15c105b86f1ba3e68d))
* **ios:** adapt the app to iPhone Duo's inner and outer displays ([#233](https://github.com/HushOS/HushOS/issues/233)) ([f42366b](https://github.com/HushOS/HushOS/commit/f42366bae0ed81b2fbc6c43c607ab0cfb17a0633))
* **ios:** share with someone as soon as they're added ([#239](https://github.com/HushOS/HushOS/issues/239)) ([89b21b8](https://github.com/HushOS/HushOS/commit/89b21b886303b3d05fa963f9d8f216cf909a58f4))
* **ios:** tint the row whose Info is open beside the list ([#235](https://github.com/HushOS/HushOS/issues/235)) ([2512e89](https://github.com/HushOS/HushOS/commit/2512e89eabb7b36338a6550d999d3048b38cf4d7))
* **tokens:** make the dark ground true black ([#236](https://github.com/HushOS/HushOS/issues/236)) ([9be67b7](https://github.com/HushOS/HushOS/commit/9be67b7e59464a0c08d8512e1f2644e1f965ae7f))
* **web:** add a dev-only component playground with live controls ([#219](https://github.com/HushOS/HushOS/issues/219)) ([3ab0404](https://github.com/HushOS/HushOS/commit/3ab0404e53ba52835fed85396681544e611eb2d6))
* **web:** let people into a family without comparing words ([#231](https://github.com/HushOS/HushOS/issues/231)) ([745fd28](https://github.com/HushOS/HushOS/commit/745fd289c3e15933659dce4ee5e4e1f5e86e3a90))
* **web:** share with someone as soon as they're added ([#222](https://github.com/HushOS/HushOS/issues/222)) ([c4dff12](https://github.com/HushOS/HushOS/commit/c4dff12150807181aa5865c81674aef455dfe48a))


### Bug fixes

* **android:** drop "once approved" from the release notes' Google Play line ([#195](https://github.com/HushOS/HushOS/issues/195)) ([2fcd8c9](https://github.com/HushOS/HushOS/commit/2fcd8c927b603799a452b2524eeacb0e296deab1))
* **billing:** end a family's unpaid plan before a new one is bought ([#188](https://github.com/HushOS/HushOS/issues/188)) ([deb9b12](https://github.com/HushOS/HushOS/commit/deb9b12ff221d8f0aa0cc9dcda1f9928fb6e4b50))
* **billing:** keep the newest Polar reading when reconciles overlap ([#205](https://github.com/HushOS/HushOS/issues/205)) ([efa5e47](https://github.com/HushOS/HushOS/commit/efa5e4724601d31ae7d966fd342a5af3c0827e9f))
* **billing:** revoke a deleted family's plan that Polar bills again ([#189](https://github.com/HushOS/HushOS/issues/189)) ([41cfde5](https://github.com/HushOS/HushOS/commit/41cfde5eb17146caa7b480fcb441d804189d3e2e))
* **crypto:** give every ledger a generation no other ledger holds ([#197](https://github.com/HushOS/HushOS/issues/197)) ([a1cc098](https://github.com/HushOS/HushOS/commit/a1cc0982af998ce481cbd73978280eba5a6187b6))
* **ios:** name HushOSKit's ServedContactKeys in the tests that also import the core ([#227](https://github.com/HushOS/HushOS/issues/227)) ([81234be](https://github.com/HushOS/HushOS/commit/81234be44bf8d062817b606d2a6b1a87a6658251))
* **mobile:** leave no rollback marks on a phone after sign-out ([#229](https://github.com/HushOS/HushOS/issues/229)) ([c144e03](https://github.com/HushOS/HushOS/commit/c144e033e182e3e1077fcfd99f8a2530a523ed68))
* never revoke a share because a check failed for another reason ([#240](https://github.com/HushOS/HushOS/issues/240)) ([3e9518f](https://github.com/HushOS/HushOS/commit/3e9518f78ebff28ba96fcf6bc75176f93dd0f5eb))
* **web:** draw outline buttons as outlines on the black panel ([#237](https://github.com/HushOS/HushOS/issues/237)) ([7546002](https://github.com/HushOS/HushOS/commit/754600263e01a179364dffcbfd08922d6d515fab))
* **web:** draw the keyboard focus outline again ([#213](https://github.com/HushOS/HushOS/issues/213)) ([fdaa9d3](https://github.com/HushOS/HushOS/commit/fdaa9d3db49481108185fdaaae88ea651081cd86))
* **web:** keep the Markdown preview inside the screen on phones ([#218](https://github.com/HushOS/HushOS/issues/218)) ([6c08297](https://github.com/HushOS/HushOS/commit/6c0829789173e5b9e425f97ff0d0c2e866631104))
* **web:** keep the sign-up code behind "Have a code?" ([#209](https://github.com/HushOS/HushOS/issues/209)) ([e350a94](https://github.com/HushOS/HushOS/commit/e350a944641c090a6f9a4f32bd24b0a12b9086cb))
* **web:** keep toasts at the bottom, in front of the transfers panel ([#223](https://github.com/HushOS/HushOS/issues/223)) ([ec001ee](https://github.com/HushOS/HushOS/commit/ec001ee2feaf25f320c9889858581cff55f7a017))
* **web:** leave nothing of an account in the browser after sign-out ([#224](https://github.com/HushOS/HushOS/issues/224)) ([aea2985](https://github.com/HushOS/HushOS/commit/aea298561db8c29509a2028e6d0e0af10c31a768))
* **web:** name the family plan once, and colour members' plan notices ([#220](https://github.com/HushOS/HushOS/issues/220)) ([6abe10d](https://github.com/HushOS/HushOS/commit/6abe10d3c5c3b260dbb69961e0424df57952fc8d))
* **web:** one section pattern on the family page; rename, cancel and resume a family plan; one Trash list ([#202](https://github.com/HushOS/HushOS/issues/202)) ([6ed4a73](https://github.com/HushOS/HushOS/commit/6ed4a73bd1b49635604158daaed510a31d2864cb))
* **web:** open a re-check on the words, not the email form ([#217](https://github.com/HushOS/HushOS/issues/217)) ([76ed743](https://github.com/HushOS/HushOS/commit/76ed743f1826c02ba15939a5be0e399c464f26bb))
* **web:** raise the chosen segment out of a soft groove so the switch reads ([#221](https://github.com/HushOS/HushOS/issues/221)) ([502f1ec](https://github.com/HushOS/HushOS/commit/502f1ec2b28be1071f67565dfa35e59299d879aa))

## [0.10.0](https://github.com/HushOS/HushOS/compare/v0.9.0...v0.10.0) (2026-10-26)


### Features

* **android,ios:** name a device after its phone model ([#142](https://github.com/HushOS/HushOS/issues/142)) ([9ec85c6](https://github.com/HushOS/HushOS/commit/9ec85c6a9d7639ad7013f373d3c0ea27a678de78))
* **android:** show where a family member's storage comes from ([#154](https://github.com/HushOS/HushOS/issues/154)) ([12df5f2](https://github.com/HushOS/HushOS/commit/12df5f25871a24410505c901ce38a7990d8be729))
* call the people you check before sharing Contacts, at /app/contacts ([#192](https://github.com/HushOS/HushOS/issues/192)) ([28f3ec7](https://github.com/HushOS/HushOS/commit/28f3ec72c5aa7db5257e9b549b4a133d355888a1))
* **db:** purge a dissolved family's records after 30 days ([#164](https://github.com/HushOS/HushOS/issues/164)) ([054d290](https://github.com/HushOS/HushOS/commit/054d290f2ac59479749fbc7f8f9715f600b7ed17))
* **drive:** delete a Trash selection forever in one request ([#173](https://github.com/HushOS/HushOS/issues/173)) ([0264843](https://github.com/HushOS/HushOS/commit/026484345ac2dfeb82f2a78a375987acfab60360))
* **drive:** move files between My files and family folders without spending storage ([#140](https://github.com/HushOS/HushOS/issues/140)) ([0564b38](https://github.com/HushOS/HushOS/commit/0564b388b3d6355f69f5a3fed90b3d5015d3c2f6))
* **drive:** trash and restore a selection in one request ([#162](https://github.com/HushOS/HushOS/issues/162)) ([125b101](https://github.com/HushOS/HushOS/commit/125b101073558ddca06890091c8fec484c8985ab))
* **ios:** show where a family member's storage comes from ([#153](https://github.com/HushOS/HushOS/issues/153)) ([59ccc33](https://github.com/HushOS/HushOS/commit/59ccc33dd891a076387378a6a5139593df21dd40))
* **web:** give a family member one view ([#159](https://github.com/HushOS/HushOS/issues/159)) ([7eec97e](https://github.com/HushOS/HushOS/commit/7eec97e01dffb23b2f4beab240c9bec06d6996fc))


### Bug fixes

* **android:** fix what the first samsung test found ([#148](https://github.com/HushOS/HushOS/issues/148)) ([5fc802f](https://github.com/HushOS/HushOS/commit/5fc802f14af65d9354b932ccb3610dd5c587861c))
* **auth:** never sign in as a new device because device storage was busy ([#163](https://github.com/HushOS/HushOS/issues/163)) ([a5e2811](https://github.com/HushOS/HushOS/commit/a5e2811167eb9a2df22fe3cff0874a4071ee4700))
* **billing:** end a dissolved family's plan at its period's end ([#168](https://github.com/HushOS/HushOS/issues/168)) ([ae1f4fe](https://github.com/HushOS/HushOS/commit/ae1f4fefe6ef02fc53f96afd55b85fbbe29fac23))
* **billing:** keep unpaid and incomplete family plans until Polar ends them ([#183](https://github.com/HushOS/HushOS/issues/183)) ([d322806](https://github.com/HushOS/HushOS/commit/d3228069025c11bde5ffd9a0ab15672cca9eabcd))
* **billing:** keep unpaid and paused personal plans until Polar ends them ([#186](https://github.com/HushOS/HushOS/issues/186)) ([68c9fe0](https://github.com/HushOS/HushOS/commit/68c9fe01ceb846463809b222efec6a2be1566d7e))
* **billing:** read every page of a person's plans before deleting their account ([#193](https://github.com/HushOS/HushOS/issues/193)) ([4ffa53f](https://github.com/HushOS/HushOS/commit/4ffa53f0639d15eb3708aca83ceeedfe0bcab38c))
* **db:** give each folder in a batch its own change number ([#177](https://github.com/HushOS/HushOS/issues/177)) ([6a5e25b](https://github.com/HushOS/HushOS/commit/6a5e25bfbc6921b2f534b3c4822623c2901340ec))
* **db:** make the change number index unique ([#179](https://github.com/HushOS/HushOS/issues/179)) ([cd314ca](https://github.com/HushOS/HushOS/commit/cd314cabcd6b3a4328448a8e99f9499d8a5cbcc1))
* **db:** refuse database tests that share another checkout's databases ([#152](https://github.com/HushOS/HushOS/issues/152)) ([1f94874](https://github.com/HushOS/HushOS/commit/1f948741b7a52e40e39d76fe153889a74fc8a8e6))
* **drive:** drop deleted items from every tab's Recent and search ([#170](https://github.com/HushOS/HushOS/issues/170)) ([01bc105](https://github.com/HushOS/HushOS/commit/01bc10577fc84d56ead01a3b0e0e744419b90830))
* **emails:** fill a template in one pass, and refuse a token nothing fills ([#176](https://github.com/HushOS/HushOS/issues/176)) ([cc4c77d](https://github.com/HushOS/HushOS/commit/cc4c77d81245aeb95a4296a8a0bacc7c7c93eff9))
* **emails:** keep placeholders in the plain-text headings fillable ([#174](https://github.com/HushOS/HushOS/issues/174)) ([4870a94](https://github.com/HushOS/HushOS/commit/4870a94e02f7a02f0562e1c17822a8da5b5c630a))
* **emails:** keep the button out of gmail's folded tail ([#143](https://github.com/HushOS/HushOS/issues/143)) ([83aca0c](https://github.com/HushOS/HushOS/commit/83aca0cbc10494c4a865c5f24c8de78ed1c9dbe3))
* **ios:** fix what the first device test found on android, on iphone too ([#149](https://github.com/HushOS/HushOS/issues/149)) ([7500284](https://github.com/HushOS/HushOS/commit/7500284d179f6f135be33b25df23303d9fd56164))
* **ios:** leave nothing of the last session behind when switching ([#150](https://github.com/HushOS/HushOS/issues/150)) ([d31aade](https://github.com/HushOS/HushOS/commit/d31aadefacaf681644e803a4695258a6dfc1f9ad))
* **ios:** let the notice's Undo take taps again ([#158](https://github.com/HushOS/HushOS/issues/158)) ([4c7f7cf](https://github.com/HushOS/HushOS/commit/4c7f7cfadfd5be599e4ee59640732b3db0b3af6e))
* **mobile:** refresh what you share after a restore and after own changes ([#180](https://github.com/HushOS/HushOS/issues/180)) ([db97bb0](https://github.com/HushOS/HushOS/commit/db97bb0206e59efac80c46f7006cead560dd8643))
* **mobile:** stop showing an ended or lapsed plan as the current plan ([#187](https://github.com/HushOS/HushOS/issues/187)) ([ff0abe7](https://github.com/HushOS/HushOS/commit/ff0abe706abd84350f872acf88a953e9b086f1df))
* **mobile:** trash a selection with one refresh and an honest count ([#157](https://github.com/HushOS/HushOS/issues/157)) ([a907850](https://github.com/HushOS/HushOS/commit/a9078509b8603298abdd9efab20bee75c70ba18d))
* **mobile:** trash and restore a selection through the batch routes ([#172](https://github.com/HushOS/HushOS/issues/172)) ([5cf2032](https://github.com/HushOS/HushOS/commit/5cf20323030d43d03a10e92edf80ee692d0d8a14))
* **web:** check a family tier before making the family, and come back from checkout to it ([#165](https://github.com/HushOS/HushOS/issues/165)) ([0cbb785](https://github.com/HushOS/HushOS/commit/0cbb7858101bf467bbcc5c266c8d9cd7c513ec16))
* **web:** hold the screen still while signing in and out ([#147](https://github.com/HushOS/HushOS/issues/147)) ([0bcf6da](https://github.com/HushOS/HushOS/commit/0bcf6daee610875882446686cd93f9e6b056c4cc))
* **web:** keep safari from freezing on page load in the ssr query stream ([#156](https://github.com/HushOS/HushOS/issues/156)) ([cd36267](https://github.com/HushOS/HushOS/commit/cd362671a039743cab0b172e9fe4cd2f25821b48))
* **web:** let browser storage recover from closed, deleted and late connections ([#160](https://github.com/HushOS/HushOS/issues/160)) ([ea6aa8a](https://github.com/HushOS/HushOS/commit/ea6aa8a3422626e160a07123d476b39d421a0211))
* **web:** open the drive in one step, with no marks on empty states ([#151](https://github.com/HushOS/HushOS/issues/151)) ([b682c67](https://github.com/HushOS/HushOS/commit/b682c67a023cbe28ff86b5a5696f15f623ee61ea))
* **web:** preload the rupee sign's font where prices are in rupees ([#182](https://github.com/HushOS/HushOS/issues/182)) ([5c3c36a](https://github.com/HushOS/HushOS/commit/5c3c36a58ee5b976d3e41ed5c8b422891926cc99))
* **web:** put a roadmap item's link after its title, clear of the rail ([#191](https://github.com/HushOS/HushOS/issues/191)) ([d62b78d](https://github.com/HushOS/HushOS/commit/d62b78d379b172faab800027003155a564dcdbd8))
* **web:** refresh what you share after a trash or restore ([#178](https://github.com/HushOS/HushOS/issues/178)) ([35ee208](https://github.com/HushOS/HushOS/commit/35ee20809a147e90cbefd44b9abf375b516ea910))
* **web:** retry a stopped key-change walk on a schedule renders can't move ([#171](https://github.com/HushOS/HushOS/issues/171)) ([f9e89f6](https://github.com/HushOS/HushOS/commit/f9e89f672bb2d2f037d68eb8f41a3e99bb49078e))
* **web:** show trashing as it happens and stop reopening each node ([#155](https://github.com/HushOS/HushOS/issues/155)) ([a709b4c](https://github.com/HushOS/HushOS/commit/a709b4c230843b8673f109b0e01aab5d6acee11a))

## 0.9.0 (2026-10-19)


### Features

* **billing:** end a personal plan when its owner's files join a family ([#129](https://github.com/HushOS/HushOS/issues/129)) ([3f3b659](https://github.com/HushOS/HushOS/commit/3f3b6590a7b7314f517e4b9c05384ee10f293fee))
* **billing:** offer families three plans sized like the personal tiers ([#65](https://github.com/HushOS/HushOS/issues/65)) ([4fb6c70](https://github.com/HushOS/HushOS/commit/4fb6c70cff027e0091a24b12f001739420f360b1))
* **billing:** refund what a customer's balance paid on their earlier card orders ([#134](https://github.com/HushOS/HushOS/issues/134)) ([0847680](https://github.com/HushOS/HushOS/commit/084768085882eff4c690e6427c423857d5f77a93))
* **crypto:** give the native core the family device record and pins ([#75](https://github.com/HushOS/HushOS/issues/75)) ([0d48ccb](https://github.com/HushOS/HushOS/commit/0d48ccb81e27eea155520726871217c9c3dadc79))
* **crypto:** give the native core the family join and successor consent ([#81](https://github.com/HushOS/HushOS/issues/81)) ([32dc072](https://github.com/HushOS/HushOS/commit/32dc072b6fd8014349ff378669809617173e535d))
* **crypto:** give the native core the family manager calls ([#103](https://github.com/HushOS/HushOS/issues/103)) ([b874b87](https://github.com/HushOS/HushOS/commit/b874b87c06b43e55c84bf85884b7c98a3c6bec81))
* **crypto:** let the native core re-key family folders and judge them ([#66](https://github.com/HushOS/HushOS/issues/66)) ([69cc82e](https://github.com/HushOS/HushOS/commit/69cc82ec41f4ea61ea51fc0820c251ca513113ca))
* **crypto:** open settings and family folder self-grants in the native core ([#107](https://github.com/HushOS/HushOS/issues/107)) ([5716d94](https://github.com/HushOS/HushOS/commit/5716d94f035ffd84f8542e86aa8908e33eaa7a38))
* **db:** keep each account in at most one family ([#109](https://github.com/HushOS/HushOS/issues/109)) ([5b54bed](https://github.com/HushOS/HushOS/commit/5b54bed898965b09293f2b325f251d1063d753fb))
* **db:** pool a family member's own files with the family folders ([#126](https://github.com/HushOS/HushOS/issues/126)) ([3b031cf](https://github.com/HushOS/HushOS/commit/3b031cf4f3895c765148ccde2b4f9b887b6c3c9b))
* **drive:** upload saved copies from memory, never from a Blob ([#115](https://github.com/HushOS/HushOS/issues/115)) ([0e83e70](https://github.com/HushOS/HushOS/commit/0e83e7009041b0523c0ad75cdb65b7328293ab60))
* **ios:** join a family from an invitation ([#125](https://github.com/HushOS/HushOS/issues/125)) ([f778370](https://github.com/HushOS/HushOS/commit/f778370d63521204814dc447696b559c029855e2))
* **ios:** open family folders read only ([#90](https://github.com/HushOS/HushOS/issues/90)) ([0a5d09a](https://github.com/HushOS/HushOS/commit/0a5d09afd34d84147b2a40aab35b25efff993ebc))
* **ios:** write to family folders through the area ledger ([#121](https://github.com/HushOS/HushOS/issues/121)) ([c1398f6](https://github.com/HushOS/HushOS/commit/c1398f661b3a1b413360af832dbb9c90eff37c96))
* **web:** draw the roadmap as a timeline ([#88](https://github.com/HushOS/HushOS/issues/88)) ([560da16](https://github.com/HushOS/HushOS/commit/560da16ac97c04a51b2becc927a2093be2b31b1c))
* **web:** give a family member one place for their family ([#112](https://github.com/HushOS/HushOS/issues/112)) ([d0c5213](https://github.com/HushOS/HushOS/commit/d0c52139a35bded9557478f6624abe50472bda53))
* **web:** give the roadmap the site's dithered covers ([#83](https://github.com/HushOS/HushOS/issues/83)) ([08be36f](https://github.com/HushOS/HushOS/commit/08be36fd614d646f9034ccbbff3a5a4f0872ab88))
* **web:** offer large files in the viewer through one card ([#105](https://github.com/HushOS/HushOS/issues/105)) ([5c4ce0d](https://github.com/HushOS/HushOS/commit/5c4ce0dee1b036299f10a33eeb331edf9497ee85))
* **web:** open JSON files as a tree in the viewer ([#100](https://github.com/HushOS/HushOS/issues/100)) ([e0d0f81](https://github.com/HushOS/HushOS/commit/e0d0f8179d75e7c48c959783e168badd2c91f85f))
* **web:** publish a roadmap that changes in the pull request that ships ([#82](https://github.com/HushOS/HushOS/issues/82)) ([10a1a99](https://github.com/HushOS/HushOS/commit/10a1a999c63c6230cae069c95f588c55114a4748))
* **web:** warn when a family's member list names a folder it doesn't own ([#79](https://github.com/HushOS/HushOS/issues/79)) ([c7a2168](https://github.com/HushOS/HushOS/commit/c7a21685bfb7630f37c652d1c90c431401786c13))


### Bug fixes

* **billing:** reopen refunds that fail after they landed ([#136](https://github.com/HushOS/HushOS/issues/136)) ([435fbe5](https://github.com/HushOS/HushOS/commit/435fbe5a3f3c69de4a055f1fd048c23efc7238b4))
* **crypto:** let an upload wait while a family's new keys arrive ([#70](https://github.com/HushOS/HushOS/issues/70)) ([40b5e46](https://github.com/HushOS/HushOS/commit/40b5e46d7b42f1513d3ca6bef6a530a4257a20d7))
* **crypto:** rewrap family self-grants as the family's in a master-key rotation ([#110](https://github.com/HushOS/HushOS/issues/110)) ([2ada387](https://github.com/HushOS/HushOS/commit/2ada387d5f62a45a2d144e0e3516fee39fb9d2f1))
* **db:** count a family's pool part by part in whole GiB in every check ([#131](https://github.com/HushOS/HushOS/issues/131)) ([a802d81](https://github.com/HushOS/HushOS/commit/a802d81cfb36c1642a954b90e4c975943cfb2274))
* **drive:** give each download reader its own key in the worker ([#119](https://github.com/HushOS/HushOS/issues/119)) ([5c43d91](https://github.com/HushOS/HushOS/commit/5c43d91c2354fb810e93bae5b4e945818b8f5779))
* **drive:** refuse shares and links in family folders on the server ([#68](https://github.com/HushOS/HushOS/issues/68)) ([7dce584](https://github.com/HushOS/HushOS/commit/7dce58420e3056e4e1ed9a3f7ea30c5d529b5186))
* **emails:** keep the logo visible when gmail inverts dark mode ([#138](https://github.com/HushOS/HushOS/issues/138)) ([e628f11](https://github.com/HushOS/HushOS/commit/e628f11ad82734b6da248f69f40d34eeddf71b27))
* **ios:** focus the join code after Compare again, and say a removal once ([#127](https://github.com/HushOS/HushOS/issues/127)) ([5d8365b](https://github.com/HushOS/HushOS/commit/5d8365bd7959a5535c69dcad308097e3add26ca4))
* **web:** clear a removed device's keys even when the stash wipe fails ([#114](https://github.com/HushOS/HushOS/issues/114)) ([de5d9d2](https://github.com/HushOS/HushOS/commit/de5d9d244b2c131e6a95490f29ad9115d8b64877))
* **web:** finish the family polish from the screenshot review ([#80](https://github.com/HushOS/HushOS/issues/80)) ([04ceb67](https://github.com/HushOS/HushOS/commit/04ceb674e5582cb07fa243f5eed14e8f289e46f5))
* **web:** fit list columns to the list, keeping who can open longest ([#77](https://github.com/HushOS/HushOS/issues/77)) ([5dbf63f](https://github.com/HushOS/HushOS/commit/5dbf63fa8d6a5792b6c0cad01660a8d564e185cc))
* **web:** fix what the screen review found in families, the viewer and Drive ([#117](https://github.com/HushOS/HushOS/issues/117)) ([e88feef](https://github.com/HushOS/HushOS/commit/e88feef5ee5bdde02e785ec9dc1d804ca75dac18))
* **web:** fold the app sidebar to its icon rail on tablets ([#101](https://github.com/HushOS/HushOS/issues/101)) ([6c562d6](https://github.com/HushOS/HushOS/commit/6c562d66fe8402f92064b12705a67798f5376f24))
* **web:** keep a family folder open when its write state changes ([#99](https://github.com/HushOS/HushOS/issues/99)) ([5a23b9d](https://github.com/HushOS/HushOS/commit/5a23b9d7626eb7466984bb314603eabf480b8687))
* **web:** keep a family's page while a new member list syncs ([#92](https://github.com/HushOS/HushOS/issues/92)) ([c868fef](https://github.com/HushOS/HushOS/commit/c868fef5a0c5acfa23b156e9555d2af544e495bd))
* **web:** keep the selection bar off the info panel and call created added ([#76](https://github.com/HushOS/HushOS/issues/76)) ([280a6ca](https://github.com/HushOS/HushOS/commit/280a6ca1da03872b2c12133b5f7b0326483d7b30))
* **web:** let people into a family that deleted a folder ([#102](https://github.com/HushOS/HushOS/issues/102)) ([f9156c3](https://github.com/HushOS/HushOS/commit/f9156c331948c46a4f2aad6b083a924485d7f14c))
* **web:** line checkboxes up with the first line of their label ([#133](https://github.com/HushOS/HushOS/issues/133)) ([f2257f0](https://github.com/HushOS/HushOS/commit/f2257f002c8edf7b7b393914981136db36d06b12))
* **web:** refresh an open versions dialog when a new version lands ([#78](https://github.com/HushOS/HushOS/issues/78)) ([f60825b](https://github.com/HushOS/HushOS/commit/f60825bb1476fa30ce2470c71db46373aeb8b18a))
* **web:** render dither marks into the page's HTML so the roadmap stops repainting ([#113](https://github.com/HushOS/HushOS/issues/113)) ([89556de](https://github.com/HushOS/HushOS/commit/89556deab49e88e4193aa0a6a888c71dbef870a5))
* **web:** say family plans hold up to 20 people and price yearly plans in whole months ([#98](https://github.com/HushOS/HushOS/issues/98)) ([2b8fcdc](https://github.com/HushOS/HushOS/commit/2b8fcdc531717ba05d7430243f1ffb5700261e39))
* **web:** say when hushos can't be reached and let managers compare again ([#74](https://github.com/HushOS/HushOS/issues/74)) ([c2ce133](https://github.com/HushOS/HushOS/commit/c2ce133cd94bf31366a4908b3f0e062873d44077))
* **web:** say who wrote a former member's file and calm a misheard word ([#63](https://github.com/HushOS/HushOS/issues/63)) ([73195b6](https://github.com/HushOS/HushOS/commit/73195b6304c914e64c0d976407eb7da4799bcadc))
* **web:** seal what Save a copy stashes on the device ([#108](https://github.com/HushOS/HushOS/issues/108)) ([c2fe4f6](https://github.com/HushOS/HushOS/commit/c2fe4f63ea50c25f269ab568ca46ac16a86eeb2d))
* **web:** tell people to try again while a key change finishes ([#71](https://github.com/HushOS/HushOS/issues/71)) ([2b7106e](https://github.com/HushOS/HushOS/commit/2b7106e8fb7ebb780bc82d179f3d406689f6ce4b))


### Performance

* **web:** paint code colour over the text instead of one element per token ([#130](https://github.com/HushOS/HushOS/issues/130)) ([47464bc](https://github.com/HushOS/HushOS/commit/47464bcd3a71e864da981756ab6db2a772cb5de2))
