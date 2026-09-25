import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

export async function POST(req: NextRequest) {
  try {
    const signature = req.headers.get("x-signature-sha256") || req.headers.get("x-signature") || req.headers.get("x-bmac-signature");
    const secret = process.env.BMAC_WEBHOOK_SECRET;

    if (!secret || !signature) {
      console.error("Missing signature or secret. Headers:", Object.fromEntries(req.headers.entries()));
      return NextResponse.json({ error: "Missing signature or secret" }, { status: 400 });
    }

    const bodyText = await req.text();
    
    // Validate signature
    // BMAC computes HMAC SHA256 of the body using your webhook secret
    const hmac = crypto.createHmac("sha256", secret);
    const calculatedSignature = hmac.update(bodyText).digest("hex");
    
    if (signature !== calculatedSignature) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(bodyText);
    
    console.log("BMAC Webhook Raw Payload:", bodyText);

    const eventData = payload.data || payload;

    const supporterEmail = eventData.support_email || eventData.supporter_email || eventData.payer_email;
    const supporterName = eventData.supporter_name || eventData.payer_name || null;
    const amount = eventData.amount; 
    const currency = eventData.currency || "AUD";
    const message = eventData.support_note || null;

    if (!supporterEmail || !amount) {
      console.error("Missing email or amount. Parsed eventData:", eventData);
      return NextResponse.json({ error: "Missing email or amount in payload" }, { status: 400 });
    }

    // Try to find matching user
    const user = await prisma.user.findUnique({
      where: { email: supporterEmail },
    });

    await prisma.donation.create({
      data: {
        userId: user ? user.id : null,
        supporterEmail,
        supporterName,
        amount: parseFloat(amount),
        currency,
        message,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("BMAC Webhook Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
