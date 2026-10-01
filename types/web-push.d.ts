declare module "web-push" {
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload?: string | Buffer
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
}
