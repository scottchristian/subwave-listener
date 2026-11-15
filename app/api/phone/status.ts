// HTTP status for each refusal a listener can hit on the phone routes. Keeping
// it in one place stops the same code answering 400 in one handler and 409 in
// another, which is how a retry loop gets written client-side.
export function linkErrorStatus(code: string): number {
  switch (code) {
    case "already_linked":
    case "phone_taken":
      return 409;
    case "send_failed":
      return 502;
    case "too_many":
    case "too_soon":
      return 429;
    case "expired":
      return 410;
    case "not_linked":
      return 409;
    default:
      return 400;
  }
}
