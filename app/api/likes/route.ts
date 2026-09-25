import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { getSubwaveConfig } from "@/lib/subwave";

// Mirror a like to the Sub/Wave host's listener likes (POST /like) so the
// DJ's topLiked/recent signal sees it. Listener endpoint, never the operator
// heart — operator curation outranks listener signal and must not be forged.
// Best-effort: local like stands even if the host is unreachable, disabled,
// or the track already turned over (409). Only real subsonic ids forward;
// "Artist - Title" fallback ids mean nothing to the host.
async function forwardHostLike(trackId: string, clientIp: string | null) {
    if (!trackId || trackId.includes(" - ")) return;
    try {
        const cfg = await getSubwaveConfig();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (clientIp) headers["X-Forwarded-For"] = clientIp;
        await fetch(`${cfg.apiUrl}/like`, {
            method: "POST",
            headers,
            body: JSON.stringify({ songId: trackId }),
            signal: AbortSignal.timeout(4000),
        });
    } catch {
        // Local like already recorded — host mirror is expendable.
    }
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const trackId = searchParams.get("trackId");
    
    if (!trackId) {
        return NextResponse.json({ error: "trackId required" }, { status: 400 });
    }
    
    try {
        const likes = await prisma.songLike.findMany({
            where: { trackId },
            include: { user: { select: { id: true, name: true, nickname: true, image: true, hideLikeName: true } } },
            orderBy: { createdAt: 'desc' }
        });
        // Name-hiders appear as Anonymous; nicknames win over sign-in names.
        // userId stays so counts and own-like detection keep working.
        const masked = likes.map(l => ({
            ...l,
            user: l.user?.hideLikeName
                ? { id: l.user.id, name: null, image: null }
                : { id: l.user.id, name: l.user.nickname || l.user.name, image: l.user.image },
        }));
        return NextResponse.json({ likes: masked });
    } catch (error) {
        console.error("GET likes error:", error);
        return NextResponse.json({ error: "Failed to fetch likes" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user || !(session.user as any).isApproved) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    const userId = (session.user as any).id;
    const body = await request.json();
    const { trackId, action } = body;
    const meta: { title?: string; artist?: string; album?: string } = {};
    if (typeof body.title === "string" && body.title) meta.title = body.title.slice(0, 300);
    if (typeof body.artist === "string" && body.artist) meta.artist = body.artist.slice(0, 300);
    if (typeof body.album === "string" && body.album) meta.album = body.album.slice(0, 300);
    
    if (!trackId || !action) {
        return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }
    
    try {
        if (action === "like") {
            const like = await prisma.songLike.upsert({
                where: { userId_trackId: { userId, trackId } },
                update: { ...meta },
                create: { userId, trackId, ...meta }
            });
            // Mirror to the host DJ signal (never fails the local like).
            const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
                || request.headers.get("x-real-ip") || null;
            await forwardHostLike(trackId, fwd);
            return NextResponse.json({ success: true, like });
        } else if (action === "unlike") {
            await prisma.songLike.delete({
                where: { userId_trackId: { userId, trackId } }
            });
            return NextResponse.json({ success: true });
        }
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (error) {
        console.error("POST like error:", error);
        return NextResponse.json({ error: "Failed to update like" }, { status: 500 });
    }
}
