import { describeReportStoreContract } from "./report-store.contract";
import { InMemoryReportStore } from "./report-store";

describeReportStoreContract("in-memory", () => new InMemoryReportStore());
