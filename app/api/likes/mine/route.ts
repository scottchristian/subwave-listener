import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// The signed-in user's own like history, newest first.
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!user || !user.isApproved) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const likes = await prisma.songLike.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' }
        });
        return NextResponse.json({ likes, hideLikeName: user.hideLikeName, userId: user.id });
    } catch (error) {
        console.error("GET mine likes error:", error);
        return NextResponse.json({ error: "Failed to fetch likes" }, { status: 500 });
    }
}
