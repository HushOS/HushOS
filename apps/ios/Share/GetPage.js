// Safari runs this on the page being shared: its title and address, for the saved link's name.
var GetPage = function () {};
GetPage.prototype = {
    run: function (args) {
        args.completionFunction({ title: document.title, url: document.URL });
    },
    finalize: function (_args) {},
};
// Safari looks this global up by name; nothing in this file reads it.
// oxlint-disable-next-line no-unused-vars
var ExtensionPreprocessingJS = new GetPage();
