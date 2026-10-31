import { describe, expect, it } from "vitest";
import {
  InMemoryCreditLedgerStore,
  availableCredits,
  creditBalanceView,
  debitCredits,
  emptyCreditAccount,
  grantStarter,
} from "./credit-ledger";

const BOARD = "board-1";
let seq = 0;
const ev = (): string => `evt-${++seq}`;
const at = (): number => 1_000 + seq;

async function grantedBoard(packCredits = 25) {
  const store = new InMemoryCreditLedgerStore();
  await store.recordPurchase(BOARD, { purchaseId: "p1", credits: packCredits });
  await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
  return store;
}

describe("credit ledger (PIN-147)", () => {
  it("availability formula is max(0, balance - frozen - pendingClawback)", () => {
    expect(availableCredits({ balance: 25, frozen: 0, pendingClawback: 0 })).toBe(25);
    expect(availableCredits({ balance: 25, frozen: 10, pendingClawback: 0 })).toBe(15);
    expect(availableCredits({ balance: 0, frozen: 0, pendingClawback: 7 })).toBe(0);
    // A corrupt state with both balance and debt still fails closed.
    expect(availableCredits({ balance: 25, frozen: 10, pendingClawback: 20 })).toBe(0);
  });

  it("starter grant is once per board; replays and second grants are no-ops", async () => {
    const store = new InMemoryCreditLedgerStore();
    const first = await store.grantStarter(BOARD, { eventId: "starter-evt", amount: 25, at: 1 });
    expect(first.applied).toBe(true);
    expect(first.entry).toMatchObject({ type: "starter_grant", amount: 25, balanceDelta: 25, balanceAfter: 25, availableAfter: 25 });
    const replay = await store.grantStarter(BOARD, { eventId: "starter-evt", amount: 25, at: 2 });
    expect(replay.applied).toBe(false);
    const second = await store.grantStarter(BOARD, { eventId: ev(), amount: 25, at: at() });
    expect(second.applied).toBe(false);
    expect(await store.getBalance(BOARD)).toEqual({ boardId: BOARD, balance: 25, frozen: 0, pendingClawback: 0, starterGranted: true, available: 25 });
    expect(await store.listEntries(BOARD)).toHaveLength(1);
  });

  it("getBalance is the head read: the starter flag plus the derived available, never conjuring an account (PIN-179)", async () => {
    const store = new InMemoryCreditLedgerStore();
    // A purchase landing before any credit touch: head exists, starter not yet granted.
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 });
    await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(await store.getBalance(BOARD)).toMatchObject({ starterGranted: false, available: 60 });
    await store.grantStarter(BOARD, { eventId: "starter-evt", amount: 25, at: at() });
    await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 10, at: at() });
    const view = await store.getBalance(BOARD);
    expect(view).toEqual({ boardId: BOARD, balance: 85, frozen: 10, pendingClawback: 0, starterGranted: true, available: 75 });
    expect(view.available).toBe(availableCredits(view));
    await store.getBalance("ghost");
    expect(await store.getAccount("ghost")).toBeNull();
  });

  it("purchase grant is idempotent by purchase id, and by event id", async () => {
    const store = new InMemoryCreditLedgerStore();
    expect((await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 })).applied).toBe(true);
    expect((await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 })).applied).toBe(false);
    await expect(store.recordPurchase(BOARD, { purchaseId: "p1", credits: 25 })).rejects.toThrow(RangeError);
    const grantEvent = ev();
    expect((await store.grantPurchase(BOARD, { eventId: grantEvent, purchaseId: "p1", at: at() })).applied).toBe(true);
    expect((await store.grantPurchase(BOARD, { eventId: grantEvent, purchaseId: "p1", at: at() })).applied).toBe(false);
    expect((await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() })).applied).toBe(false);
    expect((await store.getBalance(BOARD)).balance).toBe(60);
    expect((await store.getAccount(BOARD))?.purchases.p1.state).toBe("granted");
    await expect(store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "nope", at: at() })).rejects.toThrow(RangeError);
  });

  it("debit spends only available; an over-debit throws and writes nothing; event replays no-op", async () => {
    const store = await grantedBoard(25);
    const debitEvent = ev();
    expect((await store.debit(BOARD, { eventId: debitEvent, amount: 10, at: at() })).applied).toBe(true);
    expect((await store.debit(BOARD, { eventId: debitEvent, amount: 10, at: at() })).applied).toBe(false);
    const before = await store.getAccount(BOARD);
    await expect(store.debit(BOARD, { eventId: ev(), amount: 16, at: at() })).rejects.toThrow(/exceeds available 15/);
    expect(await store.getAccount(BOARD)).toEqual(before);
    await expect(store.debit(BOARD, { eventId: ev(), amount: 0, at: at() })).rejects.toThrow(RangeError);
    await expect(store.debit(BOARD, { eventId: ev(), amount: 1.5, at: at() })).rejects.toThrow(RangeError);
  });

  it("balance never goes negative: clawback shortfall becomes pendingClawback taken from future grants", async () => {
    const store = await grantedBoard(25);
    await store.debit(BOARD, { eventId: ev(), amount: 20, at: at() });
    const claw = await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 25, refundId: "re-1", at: at() });
    expect(claw.entry).toMatchObject({ type: "clawback", amount: 25, balanceDelta: -5, pendingClawbackDelta: 20, balanceAfter: 0, pendingClawbackAfter: 20, availableAfter: 0 });
    expect((await store.getAccount(BOARD))?.purchases.p1.state).toBe("clawed_back");

    // A future grant pays the debt first; only the remainder is spendable.
    await store.recordPurchase(BOARD, { purchaseId: "p2", credits: 25 });
    const grant = await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p2", at: at() });
    expect(grant.entry).toMatchObject({ type: "purchase_grant", amount: 25, balanceDelta: 5, pendingClawbackDelta: -20, balanceAfter: 5, pendingClawbackAfter: 0, availableAfter: 5 });

    // A grant smaller than the debt lands nothing and keeps the rest as debt.
    const store2 = await grantedBoard(25);
    await store2.debit(BOARD, { eventId: ev(), amount: 25, at: at() });
    await store2.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 25, at: at() });
    const starter = await store2.grantStarter(BOARD, { eventId: ev(), amount: 10, at: at() });
    expect(starter.entry).toMatchObject({ balanceDelta: 0, pendingClawbackDelta: -10, balanceAfter: 0, pendingClawbackAfter: 15, availableAfter: 0 });
  });

  it("clawback before grant records against the pending purchase and nets to zero at grant", async () => {
    const store = new InMemoryCreditLedgerStore();
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 });
    const claw = await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 60, refundId: "re-1", at: at() });
    expect(claw.entry).toMatchObject({ balanceDelta: 0, pendingClawbackDelta: 0, balanceAfter: 0 });
    expect((await store.getAccount(BOARD))?.purchases.p1).toMatchObject({ state: "pending", clawedCredits: 60 });
    const grant = await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(grant.entry).toMatchObject({ amount: 60, balanceDelta: 0, balanceAfter: 0, availableAfter: 0 });
    expect((await store.getAccount(BOARD))?.purchases.p1.state).toBe("clawed_back");
    expect((await store.getBalance(BOARD)).pendingClawback).toBe(0);

    // Partial pre-grant clawback: only the remainder lands.
    const store2 = new InMemoryCreditLedgerStore();
    await store2.recordPurchase(BOARD, { purchaseId: "p1", credits: 60 });
    await store2.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 15, refundId: "re-1", at: at() });
    const grant2 = await store2.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(grant2.entry).toMatchObject({ amount: 60, balanceDelta: 45, balanceAfter: 45 });
    expect((await store2.getAccount(BOARD))?.purchases.p1.state).toBe("granted");
  });

  it("partial refunds apply as per-refund deltas; a duplicate refund id is a no-op; over-clawback throws", async () => {
    const store = await grantedBoard(60);
    await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 10, refundId: "re-1", at: at() });
    const dup = await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 10, refundId: "re-1", at: at() });
    expect(dup.applied).toBe(false);
    await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 20, refundId: "re-2", at: at() });
    expect((await store.getBalance(BOARD)).balance).toBe(30);
    expect((await store.getAccount(BOARD))?.purchases.p1).toMatchObject({ state: "granted", clawedCredits: 30, refundIds: ["re-1", "re-2"] });
    await expect(
      store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 31, refundId: "re-3", at: at() }),
    ).rejects.toThrow(/past its 60 credits/);
    expect((await store.getBalance(BOARD)).balance).toBe(30);
  });

  it("freeze makes disputed makes unavailable until restore; duplicates no-op; over-freeze throws", async () => {
    const store = await grantedBoard(25);
    const freeze = await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 25, at: at() });
    expect(freeze.entry).toMatchObject({ type: "freeze", frozenDelta: 25, balanceAfter: 25, frozenAfter: 25, availableAfter: 0 });
    await expect(store.debit(BOARD, { eventId: ev(), amount: 1, at: at() })).rejects.toThrow(/exceeds available 0/);
    expect((await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 25, at: at() })).applied).toBe(false);
    const restore = await store.restore(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", at: at() });
    expect(restore.entry).toMatchObject({ type: "restore", amount: 25, frozenDelta: -25, frozenAfter: 0, availableAfter: 25 });
    expect((await store.restore(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", at: at() })).applied).toBe(false);
    expect((await store.debit(BOARD, { eventId: ev(), amount: 25, at: at() })).applied).toBe(true);
    await expect(
      store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-2", amount: 1, at: at() }),
    ).rejects.toThrow(/exceeds available 0/);
  });

  it("a dispute's final clawback consumes its frozen makes; a later restore is a no-op", async () => {
    const store = await grantedBoard(25);
    await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 25, at: at() });
    const claw = await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 25, disputeId: "dp-1", at: at() });
    expect(claw.entry).toMatchObject({ balanceDelta: -25, frozenDelta: -25, pendingClawbackDelta: 0, balanceAfter: 0, frozenAfter: 0 });
    expect((await store.getAccount(BOARD))?.purchases.p1.state).toBe("clawed_back");
    expect((await store.restore(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", at: at() })).applied).toBe(false);
  });

  it("a final clawback consumes only its own dispute's hold, never another open dispute's (PIN-233 F4)", async () => {
    const store = new InMemoryCreditLedgerStore();
    const grant = async (purchaseId: string) => {
      await store.recordPurchase(BOARD, { purchaseId, credits: 25 });
      await store.grantPurchase(BOARD, { eventId: ev(), purchaseId, at: at() });
    };
    await grant("p1");
    await grant("p2");
    await store.debit(BOARD, { eventId: ev(), amount: 35, at: at() });
    await store.freeze(BOARD, { eventId: ev(), purchaseId: "p2", disputeId: "dp-2", amount: 10, at: at() });
    // dp-1's freeze was capped at the 5 makes still available then.
    await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 5, at: at() });
    await grant("p3");
    expect(await store.getBalance(BOARD)).toMatchObject({ balance: 40, frozen: 15, available: 25 });
    // dp-1 is lost for 10 makes, more than its own 5-make hold.
    const claw = await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 10, disputeId: "dp-1", at: at() });
    expect(claw.entry).toMatchObject({ balanceDelta: -10, frozenDelta: -5, balanceAfter: 30, frozenAfter: 10, availableAfter: 20 });
    const account = await store.getAccount(BOARD);
    expect(account?.frozenByDispute).toEqual({ "dp-2": 10 });
    expect(account?.purchases.p1.resolvedDisputeIds).toEqual(["dp-1"]);
    // dp-2 still holds all 10: only the 20 truly available makes spend.
    await expect(store.debit(BOARD, { eventId: ev(), amount: 21, at: at() })).rejects.toThrow(/exceeds available 20/);
    const restore = await store.restore(BOARD, { eventId: ev(), purchaseId: "p2", disputeId: "dp-2", at: at() });
    expect(restore.entry).toMatchObject({ amount: 10, frozenDelta: -10, frozenAfter: 0, availableAfter: 30 });
  });

  it("freeze before grant is deferred and lands with the grant; restoring it pre-grant cancels it", async () => {
    const store = new InMemoryCreditLedgerStore();
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 25 });
    const freeze = await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 10, at: at() });
    expect(freeze.entry).toMatchObject({ frozenDelta: 0, frozenAfter: 0 });
    const grant = await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(grant.entry).toMatchObject({ balanceDelta: 25, frozenDelta: 10, frozenAfter: 10, availableAfter: 15 });

    const store2 = new InMemoryCreditLedgerStore();
    await store2.recordPurchase(BOARD, { purchaseId: "p1", credits: 25 });
    await store2.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 10, at: at() });
    expect((await store2.restore(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", at: at() })).applied).toBe(true);
    const grant2 = await store2.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(grant2.entry).toMatchObject({ frozenDelta: 0, availableAfter: 25 });
  });

  it("deferred freeze at grant is capped at what the grant credited, never other board makes", async () => {
    const store = new InMemoryCreditLedgerStore();
    await store.grantStarter(BOARD, { eventId: ev(), amount: 25, at: at() });
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 25 });
    await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-1", amount: 25, at: at() });
    await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 15, refundId: "re-1", at: at() });
    const grant = await store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(grant.entry).toMatchObject({ balanceDelta: 10, frozenDelta: 10, balanceAfter: 35, frozenAfter: 10, availableAfter: 25 });
    expect((await store.getAccount(BOARD))?.frozenByDispute).toEqual({ "dp-1": 10 });
    const claw = await store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 10, disputeId: "dp-1", at: at() });
    expect(claw.entry).toMatchObject({ balanceDelta: -10, frozenDelta: -10, balanceAfter: 25, frozenAfter: 0, availableAfter: 25 });
    expect((await store.getAccount(BOARD))?.purchases.p1.state).toBe("clawed_back");
  });

  it("restore before freeze records the resolution, so the later freeze is a no-op", async () => {
    const store = await grantedBoard(25);
    const early = await store.restore(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-early", at: at() });
    expect(early.applied).toBe(true);
    expect(early.entry).toMatchObject({ type: "restore", amount: 0, frozenDelta: 0, frozenAfter: 0, availableAfter: 25 });
    expect((await store.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-early", amount: 25, at: at() })).applied).toBe(false);
    expect(await store.getBalance(BOARD)).toMatchObject({ balance: 25, frozen: 0, available: 25 });

    const store2 = new InMemoryCreditLedgerStore();
    await store2.recordPurchase(BOARD, { purchaseId: "p1", credits: 25 });
    expect((await store2.restore(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-early", at: at() })).applied).toBe(true);
    expect((await store2.freeze(BOARD, { eventId: ev(), purchaseId: "p1", disputeId: "dp-early", amount: 10, at: at() })).applied).toBe(false);
    const grant = await store2.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() });
    expect(grant.entry).toMatchObject({ frozenDelta: 0, frozenAfter: 0, availableAfter: 25 });
  });

  it("close: pending intent closes, fully pre-clawed closes as clawed_back, granted cannot close", async () => {
    const store = new InMemoryCreditLedgerStore();
    await store.recordPurchase(BOARD, { purchaseId: "p1", credits: 25 });
    expect((await store.closePurchase(BOARD, { purchaseId: "p1" })).applied).toBe(true);
    expect((await store.getAccount(BOARD))?.purchases.p1.state).toBe("closed");
    expect((await store.closePurchase(BOARD, { purchaseId: "p1" })).applied).toBe(false);
    await expect(store.grantPurchase(BOARD, { eventId: ev(), purchaseId: "p1", at: at() })).rejects.toThrow(/closed/);
    await expect(store.clawback(BOARD, { eventId: ev(), purchaseId: "p1", amount: 1, at: at() })).rejects.toThrow(/closed/);

    await store.recordPurchase(BOARD, { purchaseId: "p2", credits: 25 });
    await store.clawback(BOARD, { eventId: ev(), purchaseId: "p2", amount: 25, refundId: "re-9", at: at() });
    await store.closePurchase(BOARD, { purchaseId: "p2" });
    expect((await store.getAccount(BOARD))?.purchases.p2.state).toBe("clawed_back");

    const granted = await grantedBoard(25);
    await expect(granted.closePurchase(BOARD, { purchaseId: "p1" })).rejects.toThrow(/already granted/);
  });

  it("pure operations never mutate their input; the store isolates boards and returned copies", async () => {
    const empty = emptyCreditAccount(BOARD);
    const granted = grantStarter(empty, { eventId: "e1", amount: 25, at: 1 });
    expect(empty.balance).toBe(0);
    expect(granted.account.balance).toBe(25);
    const debited = debitCredits(granted.account, { eventId: "e2", amount: 5, at: 2 });
    expect(granted.account.balance).toBe(25);
    expect(creditBalanceView(debited.account).available).toBe(20);

    const store = new InMemoryCreditLedgerStore();
    expect(await store.getAccount("ghost")).toBeNull();
    expect(await store.getBalance("ghost")).toEqual({ boardId: "ghost", balance: 0, frozen: 0, pendingClawback: 0, starterGranted: false, available: 0 });
    expect(await store.listEntries("ghost")).toEqual([]);
    await store.grantStarter(BOARD, { eventId: ev(), amount: 25, at: at() });
    await store.grantStarter("board-2", { eventId: ev(), amount: 25, at: at() });
    await store.debit(BOARD, { eventId: ev(), amount: 25, at: at() });
    expect((await store.getBalance(BOARD)).available).toBe(0);
    expect((await store.getBalance("board-2")).available).toBe(25);
    const copy = await store.getAccount("board-2");
    copy!.balance = 999;
    expect((await store.getBalance("board-2")).balance).toBe(25);
  });

  it("refundDebit re-credits a debit in full, once per debit under any event id", async () => {
    const store = new InMemoryCreditLedgerStore();
    await store.grantStarter(BOARD, { eventId: "s1", amount: 3, at: 1 });
    await store.debit(BOARD, { eventId: "debit:photo:j1", amount: 1, at: 2 });
    expect((await store.getBalance(BOARD)).available).toBe(2);

    const refunded = await store.refundDebit(BOARD, {
      eventId: "refund:photo:j1",
      debitEventId: "debit:photo:j1",
      at: 3,
    });
    expect(refunded.applied).toBe(true);
    expect(refunded.entry).toMatchObject({
      type: "debit_refund",
      amount: 1,
      balanceDelta: 1,
      debitEventId: "debit:photo:j1",
    });
    expect((await store.getBalance(BOARD)).available).toBe(3);

    // Same refund event id: replay no-op. Different id, same debit: still no-op.
    expect(
      (await store.refundDebit(BOARD, { eventId: "refund:photo:j1", debitEventId: "debit:photo:j1", at: 4 })).applied,
    ).toBe(false);
    expect(
      (await store.refundDebit(BOARD, { eventId: "refund-again", debitEventId: "debit:photo:j1", at: 5 })).applied,
    ).toBe(false);
    expect((await store.getBalance(BOARD)).available).toBe(3);

    // Unknown debit: throws, writes nothing.
    await expect(
      store.refundDebit(BOARD, { eventId: "refund:ghost", debitEventId: "debit:photo:ghost", at: 6 }),
    ).rejects.toThrow(RangeError);
    expect((await store.listEntries(BOARD)).filter((e) => e.type === "debit_refund")).toHaveLength(1);
  });
});
