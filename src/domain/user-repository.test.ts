import { describeUserRepositoryContract } from "./user-repository.contract";
import { InMemoryUserRepository } from "./user-repository";

describeUserRepositoryContract("memory", () => new InMemoryUserRepository());
