import 'server-only';

import { NextResponse } from 'next/server';
import { User } from 'lucia';
import queryString from 'query-string';

import { getUser } from '@/lib/utils.server';
import { z } from '@/server/zod';
import { db } from '@/services/db';

export class ApiError extends Error {
    constructor(
        message: string,
        public data: unknown = {},
        public status: number = 500
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

export type Context<Input> = {
    db: typeof db;
    user: User | null;
    input: Input;
};

export type RouteHandler<Input, Output> = (
    ctx: Context<Input>,
    request: Request
) => Output | Promise<Output>;

function isSchemaEmpty<T>(schema: z.ZodType<T>) {
    return schema.safeParse({}).success;
}

type ParseType = 'params' | 'body';

export function defineRoute<Input, Output>({
    input,
    output,
    handler,
    parseType,
}: {
    input: z.ZodType<Input>;
    output?: z.ZodType<Output>;
    handler: RouteHandler<Input, Output>;
    parseType: ParseType;
}) {
    return async (request: Request) => {
        const user = await getUser();

        try {
            if (isSchemaEmpty(input)) {
                const response = await handler({ db, user, input: {} as Input }, request);
                return NextResponse.json(response);
            }

            let unsafeData: unknown;
            switch (parseType) {
                case 'params':
                    unsafeData = queryString.parseUrl(request.url).query;
                    break;
                case 'body':
                    unsafeData = await request.json();
                    break;
            }

            const data = input.parse(unsafeData);
            const response = await handler({ db, user, input: data }, request);

            if (output === undefined) {
                return new Response(null, { status: 204 });
            }

            return NextResponse.json(response);
        } catch (error) {
            if (error instanceof z.ZodError) {
                return NextResponse.json(error, { status: 400 });
            }

            if (error instanceof ApiError) {
                return NextResponse.json(error.data, { status: error.status });
            }

            if (error instanceof Error) {
                return NextResponse.json({ error: error.message }, { status: 500 });
            }

            return NextResponse.json({ error: 'An unknown error occurred.' }, { status: 500 });
        }
    };
}
