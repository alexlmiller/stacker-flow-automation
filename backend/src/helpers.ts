import { poxAddressToBtcAddress, StackingClient } from '@stacks/stacking';
import {
  LIMIT,
  STACKS_NETWORK_NAME,
  POOL_OPERATOR,
  POX_CONTRACT_ADDRESS,
  MAX_CYCLES_FOR_OPERATIONS,
  STACKS_NETWORK_INSTANCE,
  FIRST_POX_4_CYCLE,
  NETWORK,
  NetworkUsed,
} from './consts';
import {
  fetchData,
  fetchAddressTransactions,
  fetchRewardCycleIndex,
  fetchTransactionInfo,
} from './api-calls';
import { query } from './db';
import {
  clearAcceptedDelegations,
  clearCommittedDelegations,
  clearDelegations,
  clearPreviousDelegations,
  createAcceptedDelegationsTable,
  createCommittedDelegationsTable,
  createDelegationsTable,
  createEventsTable,
  createPendingTransactionsTable,
  createPreviousDelegationsTable,
  createRewardIndexesTable,
} from './models';
import { DatabaseEntry, AvailableTransaction } from './types';
import {
  acceptDelegation,
  commitDelegation,
  extendDelegation,
  increaseCommitment,
  increaseDelegation,
  sleep,
} from './transactions';
import {
  deleteEvents,
  deletePendingTransaction,
  deleteRewardIndexes,
  getDatabaseEvents,
  getPendingTransactions,
  getRewardIndexes,
  saveEvents,
  savePendingTransaction,
  saveRewardIndexes,
} from './save-data';
import { getNonce } from '@stacks/transactions';

export const parseStringToJSON = (input: string) => {
  const parseValue = (value: string): string | null | NonNullable<unknown> => {
    if (value.startsWith('(tuple')) {
      return parseTuple(value);
    } else if (value.startsWith('(some')) {
      return parseSome(value);
    } else if (value === 'none') {
      return null;
    } else if (value.startsWith('u')) {
      return parseInt(value.slice(1), 10);
    } else if (value.startsWith('0x')) {
      return value;
    } else if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    } else if (value.startsWith("'")) {
      return value.slice(1);
    } else if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    } else if (value.startsWith('"')) {
      return value.slice(1);
    } else {
      return value;
    }
  };

  const parseTuple = (value: string) => {
    const obj: any = {};
    const tupleContent = value.slice(7, -1).trim();
    const entries = splitEntries(tupleContent);

    entries.forEach((entry) => {
      const spaceIndex = entry.indexOf(' ');
      const key = entry.slice(1, spaceIndex);
      const val = entry
        .slice(spaceIndex + 1)
        .trim()
        .slice(0, -1);
      obj[key] = parseValue(val);
    });

    return obj;
  };

  const parseSome = (value: string) => {
    const someContent = value.slice(5, -1).trim();
    return parseValue(someContent);
  };

  const splitEntries = (content: string) => {
    const entries = [];
    let bracketCount = 0;
    let startIdx = 0;

    for (let i = 0; i < content.length; i++) {
      if (content[i] === '(') bracketCount++;
      if (content[i] === ')') bracketCount--;
      if (
        bracketCount === 0 &&
        (content[i] === ' ' || i === content.length - 1)
      ) {
        entries.push(content.slice(startIdx, i + 1).trim());
        startIdx = i + 1;
      }
    }

    return entries;
  };

  const parseMain = (input: string) => {
    const mainContent = input.slice(4, -1).trim();
    if (mainContent.startsWith('(tuple')) {
      return parseTuple(mainContent);
    } else {
      const entries = splitEntries(mainContent);
      const result: any = {};

      entries.forEach((entry) => {
        const spaceIndex = entry.indexOf(' ');
        const key = entry.slice(1, spaceIndex);
        const val = entry
          .slice(spaceIndex + 1)
          .trim()
          .slice(0, -1);
        result[key] = parseValue(val);
      });

      return result;
    }
  };

  return parseMain(input);
};

// Fetch all transactions for an address, paginating through all pages
const fetchAllAddressTransactions = async (address: string): Promise<any[]> => {
  const allTxs: any[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await fetchAddressTransactions(address, limit, offset);
    if (!data || !data.results || data.results.length === 0) break;
    allTxs.push(...data.results);
    if (allTxs.length >= data.total) break;
    offset += limit;
  }

  return allTxs;
};

export const getEvents = async () => {
  const rawEvents: any[] = [];
  const events: any[] = [];

  console.log('Fetching pool operator transactions...');

  // Step 1: Get all pool operator transactions
  const poolTxs = await fetchAllAddressTransactions(POOL_OPERATOR as string);
  console.log(`Found ${poolTxs.length} pool operator transactions`);

  // Step 2: Collect stacker addresses from pool's delegate-stack-* calls
  // and fetch events from each successful pool tx
  const stackerAddresses = new Set<string>();
  const successfulPoxTxIds: string[] = [];

  for (const tx of poolTxs) {
    if (tx.tx_status !== 'success' || tx.tx_type !== 'contract_call') continue;
    const cc = tx.contract_call;
    if (!cc || !cc.contract_id?.includes('pox')) continue;

    successfulPoxTxIds.push(tx.tx_id);

    // Extract stacker address from delegate-stack-* calls (first arg)
    if (['delegate-stack-stx', 'delegate-stack-extend', 'delegate-stack-increase'].includes(cc.function_name)) {
      const stackerArg = cc.function_args?.[0]?.repr;
      if (stackerArg) {
        stackerAddresses.add(stackerArg.replace(/^'/, ''));
      }
    }
  }

  console.log(`Found ${successfulPoxTxIds.length} successful PoX transactions, ${stackerAddresses.size} unique stackers`);

  // Step 3: Fetch events from each successful pool tx
  for (let i = 0; i < successfulPoxTxIds.length; i++) {
    const txData = await fetchTransactionInfo(successfulPoxTxIds[i]);
    if (txData?.events) {
      for (const event of txData.events) {
        if (event.event_type === 'smart_contract_log' &&
            event.contract_log?.contract_id === POX_CONTRACT_ADDRESS) {
          rawEvents.push(event);
        }
      }
    }
    if ((i + 1) % 50 === 0) {
      console.log(`Fetched events from ${i + 1}/${successfulPoxTxIds.length} pool transactions...`);
    }
  }

  console.log(`Fetched ${rawEvents.length} events from pool transactions`);

  // Step 4: Fetch each stacker's delegate-stx and revoke-delegate-stx events
  for (const stacker of stackerAddresses) {
    console.log(`Fetching transactions for stacker ${stacker}...`);
    const stackerTxs = await fetchAllAddressTransactions(stacker);

    for (const tx of stackerTxs) {
      if (tx.tx_status !== 'success' || tx.tx_type !== 'contract_call') continue;
      const cc = tx.contract_call;
      if (!cc?.contract_id?.includes('pox')) continue;
      if (!['delegate-stx', 'revoke-delegate-stx'].includes(cc.function_name)) continue;

      const txData = await fetchTransactionInfo(tx.tx_id);
      if (txData?.events) {
        for (const event of txData.events) {
          if (event.event_type === 'smart_contract_log' &&
              event.contract_log?.contract_id === POX_CONTRACT_ADDRESS &&
              event.contract_log?.value?.repr?.includes(POOL_OPERATOR as string)) {
            rawEvents.push(event);
          }
        }
      }
    }
  }

  console.log(`Total raw events collected: ${rawEvents.length}`);

  // Sort events chronologically by block height (oldest first)
  rawEvents.sort((a: any, b: any) => {
    const blockA = a.tx_id || '';
    const blockB = b.tx_id || '';
    return blockA.localeCompare(blockB);
  });

  // Clear and re-save events to DB
  await deleteEvents();
  await saveEvents(rawEvents);

  // Parse events into structured format (same logic as original)
  for (const entry of rawEvents) {
    if (entry?.contract_log?.contract_id === POX_CONTRACT_ADDRESS && entry?.contract_log?.value?.repr?.includes(POOL_OPERATOR)) {
      const result = parseStringToJSON(entry.contract_log.value.repr);
      if (result.name == 'delegate-stx') {
        events.push({
          name: result.name,
          stacker: result.stacker,
          amountUstx: result.data['amount-ustx'],
          startCycle: result.data['start-cycle-id'],
          endCycle: result.data['end-cycle-id'],
          poxAddress:
            result.data['pox-addr'] != null
              ? poxAddressToBtcAddress(
                  parseInt(result.data['pox-addr'].version, 16),
                  Uint8Array.from(
                    Buffer.from(
                      result.data['pox-addr'].hashbytes.slice(2),
                      'hex'
                    )
                  ),
                  STACKS_NETWORK_NAME
                )
              : null,
        });
      } else if (result.name == 'revoke-delegate-stx') {
        events.push({
          name: result.name,
          stacker: result.stacker,
          startCycle: result.data['start-cycle-id'],
          endCycle: result.data['end-cycle-id'],
        });
      } else if (result.name == 'delegate-stack-stx') {
        events.push({
          name: result.name,
          stacker: result.data.stacker,
          amountUstx: result.data['lock-amount'],
          startCycle: result.data['start-cycle-id'],
          endCycle: result.data['end-cycle-id'],
          poxAddress:
            result.data['pox-addr'] != null
              ? poxAddressToBtcAddress(
                  parseInt(result.data['pox-addr'].version, 16),
                  Uint8Array.from(
                    Buffer.from(
                      result.data['pox-addr'].hashbytes.slice(2),
                      'hex'
                    )
                  ),
                  STACKS_NETWORK_NAME
                )
              : null,
        });
      } else if (result.name == 'delegate-stack-extend') {
        events.push({
          name: result.name,
          stacker: result.data.stacker,
          startCycle: result.data['start-cycle-id'],
          endCycle: result.data['end-cycle-id'],
          poxAddress:
            result.data['pox-addr'] != null
              ? poxAddressToBtcAddress(
                  parseInt(result.data['pox-addr'].version, 16),
                  Uint8Array.from(
                    Buffer.from(
                      result.data['pox-addr'].hashbytes.slice(2),
                      'hex'
                    )
                  ),
                  STACKS_NETWORK_NAME
                )
              : null,
        });
      } else if (result.name == 'delegate-stack-increase') {
        events.push({
          name: result.name,
          stacker: result.data.stacker,
          startCycle: result.data['start-cycle-id'],
          endCycle: result.data['end-cycle-id'],
          increaseBy: result.data['increase-by'],
          totalLocked: result.data['total-locked'],
          poxAddress:
            result.data['pox-addr'] != null
              ? poxAddressToBtcAddress(
                  parseInt(result.data['pox-addr'].version, 16),
                  Uint8Array.from(
                    Buffer.from(
                      result.data['pox-addr'].hashbytes.slice(2),
                      'hex'
                    )
                  ),
                  STACKS_NETWORK_NAME
                )
              : null,
        });
      } else if (
        result.name == 'stack-aggregation-commit-indexed' ||
        result.name == 'stack-aggregation-commit'
      ) {
        events.push({
          name: result.name,
          amountUstx: result.data['amount-ustx'],
          cycle: result.data['reward-cycle'],
          signerKey: result.data['signer-key'],
          poxAddress:
            result.data['pox-addr'] != null
              ? poxAddressToBtcAddress(
                  parseInt(result.data['pox-addr'].version, 16),
                  Uint8Array.from(
                    Buffer.from(
                      result.data['pox-addr'].hashbytes.slice(2),
                      'hex'
                    )
                  ),
                  STACKS_NETWORK_NAME
                )
              : null,
        });
      } else if (result.name == 'stack-aggregation-increase') {
        events.push({
          name: result.name,
          amountUstx: result.data['amount-ustx'],
          cycle: result.data['reward-cycle'],
          rewardCycleIndex: result.data['reward-cycle-index'],
          signerKey: result.data['signer-key'],
          poxAddress:
            result.data['pox-addr'] != null
              ? poxAddressToBtcAddress(
                  parseInt(result.data['pox-addr'].version, 16),
                  Uint8Array.from(
                    Buffer.from(
                      result.data['pox-addr'].hashbytes.slice(2),
                      'hex'
                    )
                  ),
                  STACKS_NETWORK_NAME
                )
              : null,
        });
      }
    }
  }

  return events;
};

export const parseEvents = async (events: any, rewardIndexesMap: any) => {
  const delegations = new Map();
  const acceptedDelegations = new Map();
  const committedDelegations = new Map();
  const previousDelegations = new Map();

  for (const event of events) {
    const {
      name,
      stacker,
      startCycle,
      endCycle,
      poxAddress,
      amountUstx,
      increaseBy,
      totalLocked,
      cycle,
      signerKey,
    } = event;

    switch (name) {
      case 'delegate-stx':
        delegations.set(stacker, {
          startCycle,
          endCycle,
          poxAddress,
          amountUstx,
        });
        break;

      case 'revoke-delegate-stx':
        if (delegations.has(stacker)) {
          const delegation = delegations.get(stacker);
          if (!previousDelegations.has(stacker)) {
            previousDelegations.set(stacker, [delegation]);
          } else {
            const existingList = previousDelegations.get(stacker);
            existingList.push(delegation);
            previousDelegations.set(stacker, existingList);
          }
          delegations.delete(stacker);
        }
        break;

      case 'delegate-stack-stx':
        acceptedDelegations.set(stacker, [
          { startCycle, endCycle, poxAddress, amountUstx },
        ]);
        break;

      case 'delegate-stack-extend':
        if (acceptedDelegations.has(stacker)) {
          const existingList = acceptedDelegations.get(stacker);
          const lastEntry = existingList[existingList.length - 1];

          lastEntry.endCycle = endCycle;
          acceptedDelegations.set(stacker, existingList);
        }
        break;

      case 'delegate-stack-increase':
        if (acceptedDelegations.has(stacker)) {
          const existingList = acceptedDelegations.get(stacker);
          const lastEntry = existingList[existingList.length - 1];

          if (lastEntry.amountUstx + increaseBy === totalLocked) {
            if (lastEntry.startCycle === startCycle) {
              lastEntry.amountUstx += increaseBy;
            } else {
              const newEntry = {
                startCycle: startCycle,
                endCycle: lastEntry.endCycle,
                poxAddress: lastEntry.poxAddress,
                amountUstx: lastEntry.amountUstx + increaseBy,
              };

              lastEntry.endCycle = startCycle;
              existingList.push(newEntry);
            }
            acceptedDelegations.set(stacker, existingList);
          }
        }
        break;

      case 'stack-aggregation-commit':
      case 'stack-aggregation-commit-indexed':
        if (poxAddress) {
          const rewardIndex =
            name === 'stack-aggregation-commit'
              ? null
              : getRewardIndexForCycleAndAddress(
                  cycle,
                  poxAddress,
                  signerKey,
                  amountUstx,
                  rewardIndexesMap
                );

          if (!committedDelegations.has(poxAddress)) {
            committedDelegations.set(poxAddress, [
              {
                startCycle: cycle,
                endCycle: cycle + 1,
                amountUstx,
                rewardIndex,
              },
            ]);
          } else {
            const existingList = committedDelegations.get(poxAddress);
            existingList.push({
              startCycle: cycle,
              endCycle: cycle + 1,
              amountUstx,
              rewardIndex,
            });
            committedDelegations.set(poxAddress, existingList);
          }
        }
        break;

      case 'stack-aggregation-increase':
        if (poxAddress) {
          const existingList = committedDelegations.get(poxAddress);
          if (existingList) {
            const entry = existingList.find((e: any) => e.startCycle === cycle);
            if (entry) {
              const rewardIndex = getRewardIndexForCycleAndAddress(
                cycle,
                poxAddress,
                signerKey,
                entry.amountUstx + amountUstx,
                rewardIndexesMap
              );
              entry.amountUstx += amountUstx;
              entry.rewardIndex = rewardIndex;
            }
          }
        }
        break;
    }
  }

  return {
    delegations,
    acceptedDelegations,
    committedDelegations,
    previousDelegations,
  };
};

const getRewardIndexForCycleAndAddress = (
  rewardCycle: number,
  poxAddress: string,
  signerKey: string,
  totalUstx: number,
  rewardIndexesMap: Map<
    number,
    [
      {
        rewardIndex: number;
        poxAddress: string;
        signer: string;
        stacker: string | null;
        totalUstx: string;
      }
    ]
  >
) => {
  const rewardIndexesForCycle = rewardIndexesMap.get(rewardCycle);

  if (rewardIndexesForCycle) {
    for (const entry of rewardIndexesForCycle) {
      if (
        entry.poxAddress === poxAddress &&
        entry.signer === signerKey &&
        entry.stacker === null &&
        entry.totalUstx === totalUstx.toString()
      ) {
        return entry.rewardIndex;
      }
    }
  }

  return null;
};

export const getRewardIndexesMap = async (currentCycle: number) => {
  const map = new Map();

  let dbRewardIndexes = await getRewardIndexes();
  let lastCycle = -1;

  for (const [cycle] of dbRewardIndexes) {
    if (cycle > lastCycle) {
      lastCycle = cycle;
    }
  }

  if (lastCycle > currentCycle) {
    await deleteRewardIndexes();
    dbRewardIndexes = new Map();
    lastCycle = -1;
  }

  let rewardCycle = lastCycle === -1 ? FIRST_POX_4_CYCLE : lastCycle + 1;
  let rewardIndex = 0;
  let continueFetching = true;

  while (continueFetching) {
    const rewardCycleIndexData = await fetchRewardCycleIndex(
      rewardCycle,
      rewardIndex
    );

    if (rewardCycleIndexData.value === null) {
      if (
        rewardCycle >
          currentCycle +
            (MAX_CYCLES_FOR_OPERATIONS < 1
              ? 1
              : MAX_CYCLES_FOR_OPERATIONS > 12
              ? 12
              : MAX_CYCLES_FOR_OPERATIONS) &&
        rewardIndex === 0
      ) {
        continueFetching = false;
        break;
      } else {
        rewardIndex = 0;
        rewardCycle++;
        continue;
      }
    }

    if (!map.has(rewardCycle)) {
      map.set(rewardCycle, []);
    }

    const poxAddressCV = rewardCycleIndexData.value.value['pox-addr'].value;
    const poxAddress = poxAddressToBtcAddress(
      parseInt(poxAddressCV.version.value, 16),
      Uint8Array.from(
        Buffer.from(poxAddressCV.hashbytes.value.slice(2), 'hex')
      ),
      STACKS_NETWORK_NAME
    );
    const signer = rewardCycleIndexData.value.value.signer.value;
    const stacker = rewardCycleIndexData.value.value.stacker.value;
    const totalUstx = rewardCycleIndexData.value.value['total-ustx'].value;

    const rewardIndexData = {
      rewardIndex,
      poxAddress,
      signer,
      stacker,
      totalUstx,
    };

    map.get(rewardCycle).push(rewardIndexData);

    rewardIndex++;
  }

  const rewardIndexesToSave = new Map();
  for (let cycle = lastCycle + 1; cycle <= currentCycle; cycle++) {
    if (map.has(cycle)) {
      rewardIndexesToSave.set(cycle, map.get(cycle));
    }
  }

  await saveRewardIndexes(rewardIndexesToSave);

  const allEntries = new Map([...dbRewardIndexes, ...map]);

  return allEntries;
};

export const createAndClearTables = async () => {
  await query(createDelegationsTable);
  await query(createAcceptedDelegationsTable);
  await query(createCommittedDelegationsTable);
  await query(createPreviousDelegationsTable);
  await query(createPendingTransactionsTable);
  await query(createEventsTable);
  await query(createRewardIndexesTable);

  await clearTables();
};

export const clearTables = async () => {
  await query(clearDelegations);
  await query(clearPreviousDelegations);
  await query(clearAcceptedDelegations);
  await query(clearCommittedDelegations);
};

export const wasTransactionBroadcasted = (
  dbEntries: DatabaseEntry[],
  transaction: DatabaseEntry
) => {
  const match = dbEntries.some(
    (entry) =>
      entry.functionName === transaction.functionName &&
      (entry.stacker === transaction.stacker ||
        (entry.stacker == null && transaction.stacker == null)) &&
      (entry.poxAddress === transaction.poxAddress ||
        (entry.poxAddress == null && transaction.poxAddress == null)) &&
      (entry.rewardCycle === transaction.rewardCycle ||
        (entry.rewardCycle == null && transaction.rewardCycle == null))
  );

  return match;
};

const processTransactions = async (
  availableTransactions: any,
  nonce: bigint,
  poolClient: StackingClient,
  dbEntries: any
) => {
  let localNonce = nonce;

  for (const transaction of availableTransactions) {
    if (!wasTransactionBroadcasted(dbEntries, transaction)) {
      switch (transaction.functionName) {
        case 'delegate-stack-stx':
          const txidAcceptedDelegation = await acceptDelegation(
            transaction.stacker,
            transaction.amountUstx,
            transaction.currentBlock,
            transaction.poxAddress,
            transaction.maxCycles,
            localNonce,
            poolClient
          );
          localNonce++;
          await savePendingTransaction({
            ...transaction,
            txid: txidAcceptedDelegation,
          });
          console.log(
            `Delegation from ${transaction.stacker} was accepted for ${transaction.amountUstx} uSTX for ${transaction.maxCycles} cycles. Txid: ${txidAcceptedDelegation}`
          );
          break;

        case 'delegate-stack-extend':
          const txidExtendedDelegation = await extendDelegation(
            transaction.stacker,
            transaction.poxAddress,
            transaction.maxExtendCycles,
            localNonce,
            poolClient
          );
          localNonce++;
          await savePendingTransaction({
            ...transaction,
            txid: txidExtendedDelegation,
          });
          console.log(
            `Delegation from ${transaction.stacker} was extended for ${transaction.maxExtendCycles} cycles. Txid: ${txidExtendedDelegation}`
          );
          break;

        case 'delegate-stack-increase':
          const txidIncreasedDelegation = await increaseDelegation(
            transaction.stacker,
            transaction.poxAddress,
            transaction.increaseAmount,
            localNonce,
            poolClient
          );
          localNonce++;
          await savePendingTransaction({
            ...transaction,
            txid: txidIncreasedDelegation,
          });
          console.log(
            `Delegation from ${transaction.stacker} was increased by ${transaction.increaseAmount} uSTX. Txid: ${txidIncreasedDelegation}`
          );
          break;

        case 'stack-aggregation-commit-indexed':
          const txidCommittedDelegation = await commitDelegation(
            transaction.poxAddress,
            transaction.rewardCycle,
            localNonce,
            poolClient
          );
          localNonce++;
          await savePendingTransaction({
            ...transaction,
            txid: txidCommittedDelegation,
          });
          console.log(
            `Commitment for address ${transaction.poxAddress} was committed in cycle ${transaction.rewardCycle}. Txid: ${txidCommittedDelegation}`
          );
          break;

        case 'stack-aggregation-increase':
          const txidCIncreasedCommitment = await increaseCommitment(
            transaction.poxAddress,
            transaction.rewardCycle,
            transaction.rewardIndex,
            localNonce,
            poolClient
          );
          localNonce++;
          await savePendingTransaction({
            ...transaction,
            txid: txidCIncreasedCommitment,
          });
          console.log(
            `Commitment for address ${transaction.poxAddress} was increased from ${transaction.amountUstx} to ${transaction.finalAmount} uSTX in cycle ${transaction.rewardCycle}. Txid: ${txidCIncreasedCommitment}`
          );
          break;
      }
    }
  }
};

export const removeAnchoredTransactionsFromDatabase = async () => {
  const dbEntries = await getPendingTransactions();

  for (const transaction of dbEntries) {
    const transactionData = await fetchTransactionInfo(transaction.txid);

    if (transactionData) {
      const isTransactionInMempool = transactionData.is_unanchored !== false;
      if (!isTransactionInMempool) {
        deletePendingTransaction(transaction.txid);
      }
    } else {
      deletePendingTransaction(transaction.txid);
    }
  }

  return await getPendingTransactions();
};

export const checkAvailableTransactions = (
  delegations: any,
  acceptedDelegations: any,
  committedDelegations: any,
  currentCycle: number,
  currentBlock: number
) => {
  const availableTransactions: AvailableTransaction[] = [];
  const MAX_CYCLES =
    MAX_CYCLES_FOR_OPERATIONS > 12
      ? 12
      : MAX_CYCLES_FOR_OPERATIONS < 1
      ? 1
      : MAX_CYCLES_FOR_OPERATIONS;

  delegations.forEach(async (value: any, key: any) => {
    if (!acceptedDelegations.has(key)) {
      const maxCycles = Math.min(
        value.endCycle !== null
          ? value.endCycle - currentCycle - 1
          : MAX_CYCLES,
        MAX_CYCLES
      );
      const operation = {
        functionName: 'delegate-stack-stx',
        stacker: key,
        amountUstx: value.amountUstx,
        currentBlock,
        poxAddress: value.poxAddress,
        maxCycles,
      };
      if (maxCycles > 0) {
        availableTransactions.push(operation);
      }
    }
  });

  acceptedDelegations.forEach(async (delegationList: any, key: any) => {
    const delegation = delegations.get(key);
    if (delegation) {
      const extendOffset = MAX_CYCLES === 12 ? 0 : 1;

      const maxExtendCycles = Math.min(
        MAX_CYCLES -
          (delegationList[delegationList.length - 1].endCycle -
            currentCycle -
            extendOffset),
        delegation.endCycle !== null
          ? delegation.endCycle - currentCycle - 1
          : MAX_CYCLES,
        delegation.endCycle !== null
          ? delegation.endCycle -
              delegationList[delegationList.length - 1].endCycle
          : MAX_CYCLES
      );

      const totalAcceptedAmount =
        delegationList[delegationList.length - 1].amountUstx;

      if (maxExtendCycles > 0 && totalAcceptedAmount <= delegation.amountUstx) {
        const operation = {
          functionName: 'delegate-stack-extend',
          stacker: key,
          poxAddress: delegationList[delegationList.length - 1].poxAddress,
          maxExtendCycles,
        };
        availableTransactions.push(operation);
      }

      if (totalAcceptedAmount < delegation.amountUstx) {
        const increaseAmount = delegation.amountUstx - totalAcceptedAmount;
        const operation = {
          functionName: 'delegate-stack-increase',
          stacker: key,
          poxAddress: delegationList[delegationList.length - 1].poxAddress,
          increaseAmount,
        };
        availableTransactions.push(operation);
      }
    }
  });

  const poxAddressSet = new Set(
    [...acceptedDelegations.values()].flat().map((d) => d.poxAddress)
  );

  poxAddressSet.forEach(async (address) => {
    const acceptedDelegationsForAddress = [...acceptedDelegations.entries()]
      .flatMap(([_, delegations]) => delegations)
      .filter((d) => d.poxAddress === address);

    const maxEndCycleList = Math.max(
      ...acceptedDelegationsForAddress.map((d) => d.endCycle)
    );
    const maxEndCycle = Math.min(
      currentCycle + MAX_CYCLES + 1,
      maxEndCycleList
    );

    const startCycleList = Math.min(
      ...acceptedDelegationsForAddress.map((d) => d.startCycle)
    );
    const startCycle = Math.max(currentCycle + 1, startCycleList);

    if (!committedDelegations.has(address)) {
      for (
        let rewardCycle = startCycle;
        rewardCycle < maxEndCycle;
        rewardCycle++
      ) {
        const operation = {
          functionName: 'stack-aggregation-commit-indexed',
          poxAddress: address,
          rewardCycle,
        };
        availableTransactions.push(operation);
      }
    } else {
      const committedDelegationsForAddress = committedDelegations.get(address);
      const currentCommittedEndCycle = Math.max(
        ...committedDelegationsForAddress.map((d: any) => d.endCycle)
      );

      if (currentCommittedEndCycle < maxEndCycle) {
        for (
          let rewardCycle = currentCommittedEndCycle;
          rewardCycle < maxEndCycle;
          rewardCycle++
        ) {
          const operation = {
            functionName: 'stack-aggregation-commit-indexed',
            poxAddress: address,
            rewardCycle,
          };
          availableTransactions.push(operation);
        }
      }
    }
  });

  const temporaryMap = new Map();

  acceptedDelegations.forEach((entries: any) => {
    entries.forEach((entry: any) => {
      const { startCycle, endCycle, poxAddress, amountUstx } = entry;
      if (!temporaryMap.has(poxAddress)) {
        temporaryMap.set(poxAddress, new Map());
      }
      const addressMap = temporaryMap.get(poxAddress);
      for (let cycle = startCycle; cycle < endCycle; cycle++) {
        if (!addressMap.has(cycle)) {
          addressMap.set(cycle, 0);
        }
        addressMap.set(cycle, addressMap.get(cycle) + amountUstx);
      }
    });
  });

  const acceptedDelegationsPerPoxAddress = new Map();

  temporaryMap.forEach((cycleMap, poxAddress) => {
    const cyclesList: any = [];
    cycleMap.forEach((amountUstx: any, cycle: any) => {
      cyclesList.push({ cycle, amountUstx });
    });
    acceptedDelegationsPerPoxAddress.set(poxAddress, cyclesList);
  });

  committedDelegations.forEach((delegations: any, address: any) => {
    const finalEntries = acceptedDelegationsPerPoxAddress.get(address) || [];
    const finalCycles: Map<number, number> = new Map(
      finalEntries.map((entry: any) => [entry.cycle, entry.amountUstx])
    );

    delegations.forEach(
      async ({ startCycle, endCycle, amountUstx, rewardIndex }: any) => {
        for (
          let cycle = startCycle;
          cycle <
          (endCycle !== null ? endCycle : currentCycle + MAX_CYCLES + 1);
          cycle++
        ) {
          const finalAmount = finalCycles.get(cycle) || 0;
          if (
            amountUstx < finalAmount &&
            startCycle <= currentCycle + MAX_CYCLES
          ) {
            const operation = {
              functionName: 'stack-aggregation-increase',
              poxAddress: address,
              rewardCycle: cycle,
              rewardIndex,
              amountUstx,
              finalAmount,
            };
            availableTransactions.push(operation);
          }
        }
      }
    );
  });

  return availableTransactions;
};

export const checkAndBroadcastTransactions = async (
  delegations: any,
  acceptedDelegations: any,
  committedDelegations: any,
  currentCycle: number,
  currentBlock: number,
  dbEntries: any
) => {
  const nonce = await getNonce(
    POOL_OPERATOR as string,
    STACKS_NETWORK_INSTANCE
  );
  const poolClient = new StackingClient(
    POOL_OPERATOR as string,
    STACKS_NETWORK_INSTANCE
  );

  delegations.forEach((value: any, key: any) => {
    if (value.endCycle !== null && value.endCycle <= currentCycle) {
      delegations.delete(key);
    }
  });

  acceptedDelegations.forEach((value: any, key: any) => {
    acceptedDelegations.set(
      key,
      value.filter((e: any) => e.endCycle > currentCycle)
    );
    if (acceptedDelegations.get(key).length === 0) {
      acceptedDelegations.delete(key);
    }
  });

  committedDelegations.forEach((value: any, key: any) => {
    committedDelegations.set(
      key,
      value.filter((e: any) => e.endCycle > currentCycle)
    );
    if (committedDelegations.get(key).length === 0) {
      committedDelegations.delete(key);
    }
  });

  const availableTransactions: AvailableTransaction[] =
    checkAvailableTransactions(
      delegations,
      acceptedDelegations,
      committedDelegations,
      currentCycle,
      currentBlock
    );

  await processTransactions(
    availableTransactions,
    nonce,
    poolClient,
    dbEntries
  );
  await sleep(7500);
};
