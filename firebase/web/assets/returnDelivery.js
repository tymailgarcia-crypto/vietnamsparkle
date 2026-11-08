import { db, doc, runTransaction } from "./firebaseClient.js";

export async function returnDeliveryToAssignment(orderId) {
  const orderRef = doc(db, "orders", orderId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists()) throw new Error("This order no longer exists.");
    const status = snapshot.data().status;
    if (status === "assigned") return;
    if (status !== "out_for_delivery") throw new Error("This order is no longer out for delivery. Reload it to see its current status.");
    transaction.update(orderRef, { status: "assigned", updatedAt: new Date().toISOString() });
  });
}
