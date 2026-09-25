"use client";
import { useState, useEffect } from "react";

export default function LikeButton({ trackId, currentUserId, title, artist, album }: { trackId: string, currentUserId: string | null, title?: string, artist?: string, album?: string }) {
    const [likes, setLikes] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!trackId) return;
        setIsLoading(true);
        fetch(`/api/likes?trackId=${encodeURIComponent(trackId)}`)
            .then(res => res.json())
            .then(data => {
                if (data.likes) setLikes(data.likes);
                setIsLoading(false);
            })
            .catch(() => setIsLoading(false));
    }, [trackId]);

    const isLiked = currentUserId ? likes.some(l => l.userId === currentUserId) : false;

    const toggleLike = async () => {
        if (!currentUserId || isSubmitting) return;
        setIsSubmitting(true);
        const action = isLiked ? "unlike" : "like";
        
        // Optimistic update
        if (isLiked) {
            setLikes(likes.filter(l => l.userId !== currentUserId));
        } else {
            setLikes([{ userId: currentUserId, user: { name: "You", image: "" } }, ...likes]);
        }
        
        try {
            await fetch("/api/likes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trackId, action, title, artist, album })
            });
            // Refetch to get real data
            const res = await fetch(`/api/likes?trackId=${encodeURIComponent(trackId)}`);
            const data = await res.json();
            if (data.likes) setLikes(data.likes);
        } catch (e) {
            // Error handling ignored for brevity in optimistic UI
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!trackId) return null;

    return (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
                id="btn-like-toggle"
                onClick={toggleLike}
                disabled={!currentUserId || isLoading}
                style={{
                    background: "transparent",
                    border: "none",
                    cursor: currentUserId ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    color: isLiked ? "#E25330" : "rgba(255,255,255,0.4)", // Vermilion if liked
                    transition: "color 0.2s, transform 0.1s",
                    transform: isSubmitting ? "scale(0.9)" : "scale(1)",
                    padding: "0"
                }}
                title={isLiked ? "Unlike" : "Like"}
            >
                <svg width="24" height="24" viewBox="0 0 24 24" fill={isLiked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"></path>
                </svg>
                <span style={{ fontSize: "1rem", fontWeight: 600 }}>{likes.length > 0 ? likes.length : ""}</span>
            </button>
            
            {likes.length > 0 && (
                <div style={{ display: "flex", marginLeft: "0.5rem" }}>
                    {likes.slice(0, 4).map((l, i) => (
                        <div key={l.userId} title={l.user?.name || "Anonymous"} style={{
                            width: "28px", height: "28px", borderRadius: "50%", background: "#444",
                            marginLeft: i > 0 ? "-10px" : "0", border: "2px solid #111",
                            overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: "12px", zIndex: 10 - i
                        }}>
                            {l.user?.image ? (
                                <img id={`like-avatar-${l.userId}`} src={l.user.image} alt={l.user?.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                                <span>{(l.user?.name || "?").charAt(0).toUpperCase()}</span>
                            )}
                        </div>
                    ))}
                    {likes.length > 4 && (
                        <div style={{
                            width: "28px", height: "28px", borderRadius: "50%", background: "rgba(255,255,255,0.1)",
                            marginLeft: "-10px", border: "2px solid #111",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: "10px", zIndex: 0
                        }}>
                            +{likes.length - 4}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
