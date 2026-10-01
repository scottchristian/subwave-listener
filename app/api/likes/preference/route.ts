import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Toggle whether this user's name/photo shows beside their likes.
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    let body: { hideLikeName?: unknown };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (typeof body.hideLikeName !== "boolean") {
        return NextResponse.json({ error: "hideLikeName must be a boolean" }, { status: 400 });
    }
    try {
        const user = await prisma.user.update({
            where: { email: session.user.email },
            data: { hideLikeName: body.hideLikeName },
            select: { hideLikeName: true },
        });
        return NextResponse.json({ success: true, hideLikeName: user.hideLikeName });
    } catch (error) {
        console.error("POST like preference error:", error);
        return NextResponse.json({ error: "Failed to save preference" }, { status: 500 });
    }
}
