import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { openai } from '@ai-sdk/openai';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/start';
import { generateObject } from 'ai';
import { Highlight, themes } from 'prism-react-renderer';
import { useState, type JSX } from 'react';
import { z } from 'zod';

const explanationPartSchema = z.object({
    startIndex: z.number(),
    endIndex: z.number(),
    explanation: z.string(),
});

const inputSchema = z.object({
    query: z.string(),
    dialect: z.enum(['postgres', 'mysql', 'sqlite', 'mssql', 'other']).default('postgres'),
});

export const explainSql = createServerFn({
    method: 'POST',
})
    .validator(inputSchema)
    .handler(async ({ data: { query, dialect } }) => {
        const { object } = await generateObject({
            model: openai('gpt-4o-mini'),
            output: 'array',
            schema: explanationPartSchema,
            prompt: `Breakdown and explain the following SQL query (dialect: ${dialect}): ${query}`,
        });
        return object;
    });

export const Route = createFileRoute('/tools/sql-explainer')({
    component: RouteComponent,
    validateSearch: z.object({
        dialect: inputSchema.shape.dialect.optional().catch('postgres'),
    }),
    head(ctx) {
        return {
            meta: [
                {
                    title: 'SQL Query Explainer | HushOS',
                },
            ],
        };
    },
});

function RouteComponent() {
    const { dialect: urlDialect } = Route.useSearch();
    const navigate = useNavigate({
        from: Route.fullPath,
    });
    const dialect = urlDialect ?? 'postgres';
    const [query, setQuery] = useState('');
    const [explainerParts, setExplainerParts] = useState<z.infer<typeof explanationPartSchema>[]>(
        []
    );
    const [isLoading, setIsLoading] = useState(false);

    const handleExplain = async () => {
        setIsLoading(true);
        try {
            const parts = await explainSql({
                data: { query, dialect },
            });
            setExplainerParts(parts);
            navigate({
                search: {
                    dialect,
                },
            });
        } finally {
            setIsLoading(false);
        }
    };

    const renderQueryWithHighlights = () => {
        if (!query || explainerParts.length === 0) return null;

        return (
            <div className='bg-muted rounded-lg p-4 font-mono text-sm leading-relaxed'>
                <Highlight code={query} language='sql' theme={themes.github}>
                    {({ tokens, getLineProps, getTokenProps }) => {
                        let lastIndex = 0;
                        const elements: JSX.Element[] = [];
                        const sortedParts = [...explainerParts].sort(
                            (a, b) => a.startIndex - b.startIndex
                        );

                        tokens.forEach((line, lineIdx) => {
                            const lineElements: JSX.Element[] = [];
                            let currentPosition = lastIndex;

                            line.forEach((token, tokenIdx) => {
                                const tokenText = token.content;
                                const tokenStart = currentPosition;
                                const tokenEnd = tokenStart + tokenText.length;

                                const overlappingParts = sortedParts.filter(
                                    part => part.startIndex < tokenEnd && part.endIndex > tokenStart
                                );

                                if (overlappingParts.length > 0) {
                                    lineElements.push(
                                        <Tooltip key={`${lineIdx}-${tokenIdx}`}>
                                            <TooltipTrigger asChild>
                                                <span
                                                    {...getTokenProps({ token, key: tokenIdx })}
                                                    className='border-primary cursor-help border-b-2 border-dotted text-inherit'
                                                />
                                            </TooltipTrigger>
                                            <TooltipContent>
                                                <p className='max-w-[300px]'>
                                                    {overlappingParts[0].explanation}
                                                </p>
                                            </TooltipContent>
                                        </Tooltip>
                                    );
                                } else {
                                    lineElements.push(
                                        <span
                                            key={`${lineIdx}-${tokenIdx}`}
                                            {...getTokenProps({ token, key: tokenIdx })}
                                        />
                                    );
                                }

                                currentPosition = tokenEnd;
                            });

                            elements.push(
                                <div
                                    key={lineIdx}
                                    {...getLineProps({ line, key: lineIdx })}
                                    className='px-4'>
                                    {lineElements}
                                </div>
                            );

                            lastIndex = currentPosition;
                        });

                        return elements;
                    }}
                </Highlight>
            </div>
        );
    };

    return (
        <div className='container mx-auto max-w-3xl py-8'>
            <TooltipProvider>
                <Card>
                    <CardHeader>
                        <CardTitle>SQL Query Explainer</CardTitle>
                    </CardHeader>
                    <CardContent className='space-y-4'>
                        <div className='space-y-2'>
                            <label className='text-sm font-medium'>SQL Query</label>
                            <Textarea
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder='Enter your SQL query here...'
                                className='min-h-[150px] font-mono'
                            />
                        </div>

                        <div className='flex items-end gap-4'>
                            <div className='space-y-2'>
                                <label className='text-sm font-medium'>SQL Dialect</label>
                                <Select
                                    value={dialect}
                                    onValueChange={val => {
                                        navigate({
                                            search: {
                                                dialect: val as z.infer<
                                                    typeof inputSchema
                                                >['dialect'],
                                            },
                                        });
                                    }}>
                                    <SelectTrigger className='w-[180px]'>
                                        <SelectValue placeholder='Select dialect' />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value='postgres'>PostgreSQL</SelectItem>
                                        <SelectItem value='mysql'>MySQL</SelectItem>
                                        <SelectItem value='sqlite'>SQLite</SelectItem>
                                        <SelectItem value='mssql'>MSSQL</SelectItem>
                                        <SelectItem value='other'>Other</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <Button onClick={handleExplain} disabled={!query || isLoading}>
                                {isLoading ? 'Explaining...' : 'Explain Query'}
                            </Button>
                        </div>

                        {explainerParts.length > 0 && (
                            <div className='mt-8 space-y-6'>
                                <div>
                                    <h3 className='mb-3 text-lg font-semibold'>Explained Query</h3>
                                    {renderQueryWithHighlights()}
                                    <p className='text-muted-foreground mt-2 text-sm'>
                                        Hover over the underlined parts to see explanations.
                                    </p>
                                </div>

                                <div>
                                    <h3 className='mb-3 text-lg font-semibold'>
                                        Detailed Breakdown
                                    </h3>
                                    <Accordion type='single' collapsible className='w-full'>
                                        {explainerParts.map((part, index) => (
                                            <AccordionItem key={index} value={`item-${index}`}>
                                                <AccordionTrigger>
                                                    <div className='text-left'>
                                                        <div className='font-medium'>
                                                            Part {index + 1}
                                                        </div>
                                                        <div className='text-muted-foreground font-mono text-sm'>
                                                            {query.slice(
                                                                part.startIndex,
                                                                part.endIndex
                                                            )}
                                                        </div>
                                                    </div>
                                                </AccordionTrigger>
                                                <AccordionContent>
                                                    <p className='text-sm'>{part.explanation}</p>
                                                </AccordionContent>
                                            </AccordionItem>
                                        ))}
                                    </Accordion>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </TooltipProvider>
        </div>
    );
}
