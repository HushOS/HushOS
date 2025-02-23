/** @type {import("prettier").PrettierConfig} */
export default {
    bracketSpacing: true,
    bracketSameLine: true,
    singleQuote: true,
    jsxSingleQuote: true,
    trailingComma: 'es5',
    endOfLine: 'lf',
    arrowParens: 'avoid',
    tabWidth: 4,
    printWidth: 100,
    semi: true,

    tailwindStylesheet: './src/app.css',
    plugins: ['prettier-plugin-tailwindcss'],
};
