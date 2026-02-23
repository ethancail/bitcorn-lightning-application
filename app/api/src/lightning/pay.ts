import { payViaPaymentRequest } from "ln-service";
import { getLndClient } from "./lnd";

export async function payInvoice(paymentRequest: string) {
  const { lnd } = getLndClient();

  const result = await payViaPaymentRequest({
    lnd,
    request: paymentRequest,
  });

  return {
    id: result.id,
    tokens: result.tokens,
    fee: result.fee,
    confirmed_at: result.confirmed_at,
  };
}
