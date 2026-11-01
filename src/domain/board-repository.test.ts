import { describeBoardRepositoryContract } from "./board-repository.contract";
import { InMemoryBoardRepository } from "./board-repository";

describeBoardRepositoryContract("in-memory", () => new InMemoryBoardRepository());
