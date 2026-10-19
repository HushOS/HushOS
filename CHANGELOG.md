# Changelog

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
