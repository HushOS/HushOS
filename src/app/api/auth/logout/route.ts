import { NextResponse } from 'next/server';

import { Routes } from '@/lib/routes';
import { logout } from '@/lib/utils.server';

export async function GET() {
    await logout();
    return NextResponse.redirect(Routes.login());
}
