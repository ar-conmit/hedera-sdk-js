/*-
 * ‌
 * Hedera JavaScript SDK
 * ​
 * Copyright (C) 2020 - 2022 Hedera Hashgraph, LLC
 * ​
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ‍
 */

import Status from "../Status.js";
import AccountId from "../account/AccountId.js";
import Hbar from "../Hbar.js";
import Executable, { ExecutionState } from "../Executable.js";
import TransactionId from "../transaction/TransactionId.js";
import * as HashgraphProto from "@hashgraph/proto";
import PrecheckStatusError from "../PrecheckStatusError.js";
import MaxQueryPaymentExceeded from "../MaxQueryPaymentExceeded.js";
import Long from "long";
import Logger from "js-logger";

/**
 * @typedef {import("../channel/Channel.js").default} Channel
 * @typedef {import("../PublicKey.js").default} PublicKey
 */

/**
 * @typedef {import("../client/Client.js").ClientOperator} ClientOperator
 * @typedef {import("../client/Client.js").default<*, *>} Client
 */

/**
 * This registry holds a bunch of callbacks for `fromProtobuf()` implementations
 * Since this is essentially aa cache, perhaps we should move this variable into the `Cache`
 * type for consistency?
 *
 * @type {Map<HashgraphProto.proto.Query["query"], (query: HashgraphProto.proto.IQuery) => Query<*>>}
 */
export const QUERY_REGISTRY = new Map();

/**
 * Base class for all queries that can be submitted to Hedera.
 *
 * @abstract
 * @template OutputT
 * @augments {Executable<HashgraphProto.proto.IQuery, HashgraphProto.proto.IResponse, OutputT>}
 */
export default class Query extends Executable {
    constructor() {
        super();

        /**
         * The payment transaction ID
         *
         * @type {?TransactionId}
         */
        this._paymentTransactionId = null;

        /**
         * The payment transactions list where each index points to a different node
         *
         * @type {HashgraphProto.proto.ITransaction[]}
         */
        this._paymentTransactions = [];

        /**
         * The amount being paid to the node for this query.
         * A user can set this field explicitly, or we'll query the value during execution.
         *
         * @type {?Hbar}
         */
        this._queryPayment = null;

        /**
         * The maximum query payment a user is willing to pay. Unlike `Transaction.maxTransactionFee`
         * this field only exists in the SDK; there is no protobuf field equivalent. If and when
         * we query the actual cost of the query and the cost is greater than the max query payment
         * we'll throw a `MaxQueryPaymentExceeded` error.
         *
         * @type {?Hbar}
         */
        this._maxQueryPayment = null;

        /**
         * This is strictly used for `_getLogId()` which requires a timestamp. The timestamp it typically
         * uses comes from the payment transaction ID, but that field is not set if this query is free.
         * For those occasions we use this timestamp field generated at query construction instead.
         *
         * @type {number}
         */
        this._timestamp = Date.now();
    }

    /**
     * Deserialize a query from bytes. The bytes should be a `proto.Query`.
     *
     * @template T
     * @param {Uint8Array} bytes
     * @returns {Query<T>}
     */
    static fromBytes(bytes) {
        const query = HashgraphProto.proto.Query.decode(bytes);

        if (query.query == null) {
            throw new Error("(BUG) query.query was not set in the protobuf");
        }

        const fromProtobuf =
            /** @type {(query: HashgraphProto.proto.IQuery) => Query<T>} */ (
                QUERY_REGISTRY.get(query.query)
            );

        if (fromProtobuf == null) {
            throw new Error(
                `(BUG) Query.fromBytes() not implemented for type ${query.query}`
            );
        }

        return fromProtobuf(query);
    }

    /**
     * Serialize the query into bytes.
     *
     * **NOTE**: Does not preserve payment transactions
     *
     * @returns {Uint8Array}
     */
    toBytes() {
        return HashgraphProto.proto.Query.encode(this._makeRequest()).finish();
    }

    /**
     * Set an explicit payment amount for this query.
     *
     * The client will submit exactly this amount for the payment of this query. Hedera
     * will not return any remainder.
     *
     * @param {Hbar} queryPayment
     * @returns {this}
     */
    setQueryPayment(queryPayment) {
        this._queryPayment = queryPayment;

        return this;
    }

    /**
     * Set the maximum payment allowable for this query.
     *
     * @param {Hbar} maxQueryPayment
     * @returns {this}
     */
    setMaxQueryPayment(maxQueryPayment) {
        this._maxQueryPayment = maxQueryPayment;

        return this;
    }

    /**
     * Fetch the cost of this query from a consensus node
     *
     * @param {import("../client/Client.js").default<Channel, *>} client
     * @returns {Promise<Hbar>}
     */
    getCost(client) {
        // The node account IDs must be set to execute a cost query
        if (this._nodeAccountIds.isEmpty) {
            this._nodeAccountIds.setList(
                client._network.getNodeAccountIdsForExecute()
            );
        }

        if (COST_QUERY.length != 1) {
            throw new Error("CostQuery has not been loaded yet");
        }

        // Change the timestamp. Should we be doing this?
        this._timestamp = Date.now();

        return COST_QUERY[0](this).execute(client);
    }

    /**
     * Set he payment transaction explicitly
     *
     * @param {TransactionId} paymentTransactionId
     * @returns {this}
     */
    setPaymentTransactionId(paymentTransactionId) {
        this._paymentTransactionId = paymentTransactionId;
        return this;
    }

    /**
     * Get the payment transaction ID
     *
     * @returns {?TransactionId}
     */
    get paymentTransactionId() {
        return this._paymentTransactionId;
    }

    /**
     * Get the current transaction ID, and make sure it's not null
     *
     * @returns {TransactionId}
     */
    _getTransactionId() {
        if (this._paymentTransactionId == null) {
            throw new Error(
                "Query.PaymentTransactionId was not set duration execution"
            );
        }

        return this._paymentTransactionId;
    }

    /**
     * Is payment required for this query. By default most queries require payment
     * so the default implementation returns true.
     *
     * @protected
     * @returns {boolean}
     */
    _isPaymentRequired() {
        return true;
    }

    /**
     * Validate checksums of the query.
     *
     * @param {Client} client
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,@typescript-eslint/no-empty-function
    _validateChecksums(client) {
        // Shouldn't we be checking `paymentTransactionId` here sine it contains an `accountId`?
        // Do nothing
    }

    /**
     * Before we proceed exeuction, we need to do a couple checks
     *
     * @template MirrorChannelT
     * @param {import("../client/Client.js").default<Channel, MirrorChannelT>} client
     * @returns {Promise<void>}
     */
    async _beforeExecute(client) {
        // If we're executing this query multiple times the the payment transaction ID list
        // will already be set
        if (this._paymentTransactions.length > 0) {
            return;
        }

        // Check checksums if enabled
        if (client.isAutoValidateChecksumsEnabled()) {
            this._validateChecksums(client);
        }

        // If the nodes aren't set, set them.
        if (this._nodeAccountIds.isEmpty) {
            this._nodeAccountIds.setList(
                client._network.getNodeAccountIdsForExecute()
            );
        }

        // Save the operator
        this._operator =
            this._operator != null ? this._operator : client._operator;

        // If the payment transaction ID is not set
        if (this._paymentTransactionId == null) {
            // And payment is required
            if (this._isPaymentRequired()) {
                // And the client has an operator
                if (this._operator != null) {
                    // Generate the payment transaction ID
                    this._paymentTransactionId = TransactionId.generate(
                        this._operator.accountId
                    );
                } else {
                    // If payment is required, but an operator did not exist, throw an error
                    throw new Error(
                        "`client` must have an `operator` or an explicit payment transaction must be provided"
                    );
                }
            } else {
                // If the payment transaction ID is not set, but this query doesn't require a payment
                // set the payment transaction ID to an empty transaction ID.
                // FIXME: Should use `TransactionId.withValidStart()` instead
                this._paymentTransactionId = TransactionId.generate(
                    new AccountId(0)
                );
            }
        }

        // The cost of the query.
        //
        // FIXME: Not sure why we're setting it to `queryPayment` when this value gets
        // overwritten immediately afterwards? Looking more closely at the rest of the
        // code this definitely looks like a bug. We're treating `cost` as both
        // `queryPayment` and `maxQueryPayment`. To start we should really change
        // the name of this variable.
        //
        // Here is how it should work:
        // Legend:
        //  X = Set by user
        //  O = Not set by user (null)
        //   | queryPayment | maxQueryPayment | client.maxQueryPayment |
        // a |      O       |        O        |           O            |
        // b |      O       |        O        |           X            |
        // c |      O       |        X        |           O            |
        // d |      O       |        X        |           X            |
        // e |      X       |        O        |           O            |
        // f |      X       |        O        |           X            |
        // g |      X       |        X        |           O            |
        // h |      X       |        X        |           X            |
        //
        // e, f, g, h:
        // - Do not query the cost, use the query payment explicity
        //
        // c, d:
        // - Query the cost, and compare it to `maxQueryPayment`
        //
        // a, b:
        // - Query the cost, and compare it to `client.maxQueryPayment`
        //
        // TODO: Create a test that matches this table
        let cost = this._queryPayment;

        // Set cost to either the current max query payment, or the default on
        // client.
        if (cost == null && this._maxQueryPayment != null) {
            cost = this._maxQueryPayment;
        } else {
            cost = client.maxQueryPayment;
        }

        // If payment transactions are already created or this is a free query
        // set the cost to 0.
        if (
            this._paymentTransactions.length !== 0 ||
            !this._isPaymentRequired()
        ) {
            cost = new Hbar(0);
        } else {
            // If the query payment was not explictly set, fetch the actual cost.
            if (this._queryPayment == null) {
                const actualCost = await this.getCost(client);

                // Confirm it's less than max query payment
                if (
                    cost.toTinybars().toInt() < actualCost.toTinybars().toInt()
                ) {
                    throw new MaxQueryPaymentExceeded(cost, actualCost);
                }

                cost = actualCost;
                Logger.debug(
                    `[${this._getLogId()}] received cost for query ${cost.toString()}`
                );
            }
        }

        this._queryPayment = cost;

        // FIXME: Shouldn't this be `!this._nodeAccountIds.locked`?
        if (this._nodeAccountIds.locked) {
            // Generate the payment transactions
            for (const node of this._nodeAccountIds.list) {
                this._paymentTransactions.push(
                    await _makePaymentTransaction(
                        this._getLogId(),
                        /** @type {import("../transaction/TransactionId.js").default} */ (
                            this._paymentTransactionId
                        ),
                        node,
                        this._isPaymentRequired() ? this._operator : null,
                        /** @type {Hbar} */ (cost)
                    )
                );
            }
        }

        // Not sure if we should be overwritting this field tbh.
        this._timestamp = Date.now();
    }

    /**
     * @abstract
     * @internal
     * @param {HashgraphProto.proto.IResponse} response
     * @returns {HashgraphProto.proto.IResponseHeader}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _mapResponseHeader(response) {
        throw new Error("not implemented");
    }

    /**
     * @protected
     * @returns {HashgraphProto.proto.IQueryHeader}
     */
    _makeRequestHeader() {
        /** @type {HashgraphProto.proto.IQueryHeader} */
        let header = {};

        if (this._isPaymentRequired() && this._paymentTransactions.length > 0) {
            header = {
                responseType: HashgraphProto.proto.ResponseType.ANSWER_ONLY,
                payment: this._paymentTransactions[this._nodeAccountIds.index],
            };
        }

        return header;
    }

    /**
     * @abstract
     * @internal
     * @param {HashgraphProto.proto.IQueryHeader} header
     * @returns {HashgraphProto.proto.IQuery}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _onMakeRequest(header) {
        throw new Error("not implemented");
    }

    /**
     * @internal
     * @returns {HashgraphProto.proto.IQuery}
     */
    _makeRequest() {
        /** @type {HashgraphProto.proto.IQueryHeader} */
        let header = {};

        if (this._isPaymentRequired() && this._paymentTransactions != null) {
            header = {
                payment: this._paymentTransactions[this._nodeAccountIds.index],
                responseType: HashgraphProto.proto.ResponseType.ANSWER_ONLY,
            };
        }

        return this._onMakeRequest(header);
    }

    /**
     * @override
     * @internal
     * @returns {Promise<HashgraphProto.proto.IQuery>}
     */
    async _makeRequestAsync() {
        /** @type {HashgraphProto.proto.IQueryHeader} */
        let header = {
            responseType: HashgraphProto.proto.ResponseType.ANSWER_ONLY,
        };

        if (this._isPaymentRequired() && this._paymentTransactions != null) {
            if (this._nodeAccountIds.locked) {
                header.payment =
                    this._paymentTransactions[this._nodeAccountIds.index];
            } else {
                header.payment = await _makePaymentTransaction(
                    this._getLogId(),
                    /** @type {import("../transaction/TransactionId.js").default} */ (
                        this._paymentTransactionId
                    ),
                    this._nodeAccountIds.current,
                    this._isPaymentRequired() ? this._operator : null,
                    /** @type {Hbar} */ (this._queryPayment)
                );
            }
        }

        return this._onMakeRequest(header);
    }

    /**
     * @override
     * @internal
     * @param {HashgraphProto.proto.IQuery} request
     * @param {HashgraphProto.proto.IResponse} response
     * @returns {[Status, ExecutionState]}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _shouldRetry(request, response) {
        const { nodeTransactionPrecheckCode } =
            this._mapResponseHeader(response);

        const status = Status._fromCode(
            nodeTransactionPrecheckCode != null
                ? nodeTransactionPrecheckCode
                : HashgraphProto.proto.ResponseCodeEnum.OK
        );

        Logger.debug(
            `[${this._getLogId()}] received status ${status.toString()}`
        );

        switch (status) {
            case Status.Busy:
            case Status.Unknown:
            case Status.PlatformTransactionNotCreated:
                return [status, ExecutionState.Retry];
            case Status.Ok:
                return [status, ExecutionState.Finished];
            default:
                return [status, ExecutionState.Error];
        }
    }

    /**
     * @override
     * @internal
     * @param {HashgraphProto.proto.IQuery} request
     * @param {HashgraphProto.proto.IResponse} response
     * @returns {Error}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _mapStatusError(request, response) {
        const { nodeTransactionPrecheckCode } =
            this._mapResponseHeader(response);

        const status = Status._fromCode(
            nodeTransactionPrecheckCode != null
                ? nodeTransactionPrecheckCode
                : HashgraphProto.proto.ResponseCodeEnum.OK
        );

        return new PrecheckStatusError({
            status,
            transactionId: this._getTransactionId(),
        });
    }

    /**
     * @returns {AccountId}
     */
    _getNodeAccountId() {
        if (!this._nodeAccountIds.isEmpty) {
            // if there are payment transactions,
            // we need to use the node of the current payment transaction
            return this._nodeAccountIds.current;
        } else {
            throw new Error(
                "(BUG) nodeAccountIds were not set for query before executing"
            );
        }
    }

    /**
     * @param {HashgraphProto.proto.Query} request
     * @returns {Uint8Array}
     */
    _requestToBytes(request) {
        return HashgraphProto.proto.Query.encode(request).finish();
    }

    /**
     * @param {HashgraphProto.proto.Response} response
     * @returns {Uint8Array}
     */
    _responseToBytes(response) {
        return HashgraphProto.proto.Response.encode(response).finish();
    }
}

/**
 * Generate a payment transaction given, aka. `TransferTransaction`
 *
 * @param {string} logId
 * @param {TransactionId} paymentTransactionId
 * @param {AccountId} nodeId
 * @param {?ClientOperator} operator
 * @param {Hbar} paymentAmount
 * @returns {Promise<HashgraphProto.proto.ITransaction>}
 */
export async function _makePaymentTransaction(
    logId,
    paymentTransactionId,
    nodeId,
    operator,
    paymentAmount
) {
    Logger.debug(
        `[${logId}] making a payment transaction for node ${nodeId.toString()} and transaction ID ${paymentTransactionId.toString()} with amount ${paymentAmount.toString()}`
    );
    const accountAmounts = [];

    // If an operator is provided then we should make sure we transfer
    // from the operator to the node.
    // If an operator is not provided we simply create an effectively
    // empty account amounts
    if (operator != null) {
        accountAmounts.push({
            accountID: operator.accountId._toProtobuf(),
            amount: paymentAmount.negated().toTinybars(),
        });
        accountAmounts.push({
            accountID: nodeId._toProtobuf(),
            amount: paymentAmount.toTinybars(),
        });
    } else {
        accountAmounts.push({
            accountID: new AccountId(0)._toProtobuf(),
            // If the account ID is 0, shouldn't we just hard
            // code this value to 0? Same for the latter.
            amount: paymentAmount.negated().toTinybars(),
        });
        accountAmounts.push({
            accountID: nodeId._toProtobuf(),
            amount: paymentAmount.toTinybars(),
        });
    }
    /**
     * @type {HashgraphProto.proto.ITransactionBody}
     */
    const body = {
        transactionID: paymentTransactionId._toProtobuf(),
        nodeAccountID: nodeId._toProtobuf(),
        transactionFee: new Hbar(1).toTinybars(),
        transactionValidDuration: {
            seconds: Long.fromNumber(120),
        },
        cryptoTransfer: {
            transfers: {
                accountAmounts,
            },
        },
    };

    /** @type {HashgraphProto.proto.ISignedTransaction} */
    const signedTransaction = {
        bodyBytes: HashgraphProto.proto.TransactionBody.encode(body).finish(),
    };

    // Sign the transaction if an operator is provided
    //
    // We have _several_ places where we build the transactions, maybe this is
    // something we can deduplicate?
    if (operator != null) {
        const signature = await operator.transactionSigner(
            /** @type {Uint8Array} */ (signedTransaction.bodyBytes)
        );

        signedTransaction.sigMap = {
            sigPair: [operator.publicKey._toProtobufSignature(signature)],
        };
    }

    // Create and return a `proto.Transaction`
    return {
        signedTransactionBytes:
            HashgraphProto.proto.SignedTransaction.encode(
                signedTransaction
            ).finish(),
    };
}

/**
 * Cache for the cost query constructor. This prevents cyclic dependencies.
 *
 * @type {((query: Query<*>) => import("./CostQuery.js").default<*>)[]}
 */
export const COST_QUERY = [];
