import { C, Core } from "../core/mod.ts";
import {
  Address,
  Assets,
  CertificateValidator,
  Datum,
  Json,
  Label,
  Lovelace,
  MintingPolicy,
  OutputData,
  PaymentKeyHash,
  PoolId,
  PoolParams,
  Redeemer,
  RewardAddress,
  SpendingValidator,
  StakeKeyHash,
  UnixTime,
  UTxO,
  WithdrawalValidator,
} from "../types/mod.ts";
import { assetsToValue, fromHex, utxoToCore } from "../utils/mod.ts";
import { Lucid } from "./lucid.ts";
import { TxComplete } from "./txComplete.ts";

export class Tx {
  txBuilder: Core.TransactionBuilder;
  private tasks: (() => Promise<void>)[];
  private lucid: Lucid;

  constructor(lucid: Lucid) {
    this.lucid = lucid;
    this.txBuilder = C.TransactionBuilder.new(this.lucid.txBuilderConfig);
    this.tasks = [];
  }

  /** Read data from utxos. These utxos are only referenced and not spent */
  readFrom(utxos: UTxO[]): Tx {
    this.tasks.push(async () => {
      for (const utxo of utxos) {
        if (utxo.datumHash && !utxo.datum) {
          utxo.datum = await this.lucid.datumOf(utxo);
          // Add datum to witness set, so it can be read from validators
          const plutusData = C.PlutusData.from_bytes(fromHex(utxo.datum!));
          this.txBuilder.add_plutus_data(plutusData);
        }
        const coreUtxo = utxoToCore(utxo);
        this.txBuilder.add_reference_input(coreUtxo);
      }
    });
    return this;
  }

  /**
   * A public key or native script input.
   * With redeemer it's a plutus script input.
   */
  collectFrom(utxos: UTxO[], redeemer?: Redeemer): Tx {
    this.tasks.push(async () => {
      for (const utxo of utxos) {
        if (utxo.datumHash && !utxo.datum) {
          utxo.datum = await this.lucid.datumOf(utxo);
        }
        const coreUtxo = utxoToCore(utxo);
        this.txBuilder.add_input(
          coreUtxo,
          (redeemer as undefined) &&
            C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                utxo.datumHash && utxo.datum
                  ? C.PlutusData.from_bytes(fromHex(utxo.datum!))
                  : undefined,
                undefined,
              ),
            ),
        );
      }
    });
    return this;
  }

  /**
   * All assets should be of the same policy id.
   * You can chain mintAssets events together if you need to mint assets with different policy ids.
   * If the plutus script doesn't need a redeemer, you still neeed to specifiy the empty redeemer.
   */
  mintAssets(assets: Assets, redeemer?: Redeemer): Tx {
    const units = Object.keys(assets);
    const policyId = units[0].slice(0, 56);
    const mintAssets = C.MintAssets.new();
    units.forEach((unit) => {
      if (unit.slice(0, 56) !== policyId) {
        throw new Error(
          "Only one Policy Id allowed. You can chain multiple mintAssets events together if you need to mint assets with different Policy Ids.",
        );
      }
      mintAssets.insert(
        C.AssetName.new(fromHex(unit.slice(56))),
        C.Int.from_str(assets[unit].toString()),
      );
    });
    const scriptHash = C.ScriptHash.from_bytes(fromHex(policyId));
    this.txBuilder.add_mint(
      scriptHash,
      mintAssets,
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  /** Pay to a public key or native script address */
  payToAddress(address: Address, assets: Assets): Tx {
    const output = C.TransactionOutput.new(
      C.Address.from_bech32(address),
      assetsToValue(assets),
    );
    this.txBuilder.add_output(output);
    return this;
  }

  /** Pay to a public key or native script address with datum or scriptRef */
  payToAddressWithData(
    address: Address,
    outputData: Datum | OutputData,
    assets: Assets,
  ): Tx {
    if (typeof outputData === "string") {
      outputData = { asHash: outputData };
    }

    if (outputData.asHash && outputData.inline) {
      throw new Error("Not allowed to set asHash and inline at the same time.");
    }

    const output = C.TransactionOutput.new(
      C.Address.from_bech32(address),
      assetsToValue(assets),
    );

    if (outputData.asHash) {
      const plutusData = C.PlutusData.from_bytes(fromHex(outputData.asHash));
      output.set_datum(C.Datum.new_data_hash(C.hash_plutus_data(plutusData)));
      this.txBuilder.add_plutus_data(plutusData);
    } else if (outputData.inline) {
      const plutusData = C.PlutusData.from_bytes(fromHex(outputData.inline));
      output.set_datum(C.Datum.new_data(C.Data.new(plutusData)));
    }
    const script = outputData.scriptRef;
    if (script) {
      if (script.type === "Native") {
        output.set_script_ref(
          C.ScriptRef.new(
            C.Script.new_native(
              C.NativeScript.from_bytes(fromHex(script.script)),
            ),
          ),
        );
      } else if (script.type === "PlutusV1") {
        output.set_script_ref(
          C.ScriptRef.new(
            C.Script.new_plutus_v1(
              C.PlutusScript.from_bytes(fromHex(script.script)),
            ),
          ),
        );
      } else if (script.type === "PlutusV2") {
        output.set_script_ref(
          C.ScriptRef.new(
            C.Script.new_plutus_v2(
              C.PlutusScript.from_bytes(fromHex(script.script)),
            ),
          ),
        );
      }
    }
    this.txBuilder.add_output(output);
    return this;
  }

  /** Pay to a plutus script address with datum or scriptRef */
  payToContract(
    address: Address,
    outputData: Datum | OutputData,
    assets: Assets,
  ): Tx {
    if (typeof outputData === "string") {
      outputData = { asHash: outputData };
    }

    if (!(outputData.asHash || outputData.inline)) {
      throw new Error(
        "No datum set. Script output becomes unspendable without datum.",
      );
    }

    return this.payToAddressWithData(address, outputData, assets);
  }

  /** Delegate to a stake pool. */
  delegateTo(
    rewardAddress: RewardAddress,
    poolId: PoolId,
    redeemer?: Redeemer,
  ): Tx {
    const addressDetails = this.lucid.utils.getAddressDetails(rewardAddress);
    if (
      addressDetails.address.type !== "Reward" ||
      !addressDetails.stakeCredential
    ) {
      throw new Error("Not a reward address provided.");
    }
    const credential = addressDetails.stakeCredential.type === "Key"
      ? C.StakeCredential.from_keyhash(
        C.Ed25519KeyHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      )
      : C.StakeCredential.from_scripthash(
        C.ScriptHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      );

    this.txBuilder.add_certificate(
      C.Certificate.new_stake_delegation(
        C.StakeDelegation.new(credential, C.Ed25519KeyHash.from_bech32(poolId)),
      ),
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  /** Register a reward address in order to delegate to a pool and receive rewards. */
  registerStake(rewardAddress: RewardAddress): Tx {
    const addressDetails = this.lucid.utils.getAddressDetails(rewardAddress);
    if (
      addressDetails.address.type !== "Reward" ||
      !addressDetails.stakeCredential
    ) {
      throw new Error("Not a reward address provided.");
    }
    const credential = addressDetails.stakeCredential.type === "Key"
      ? C.StakeCredential.from_keyhash(
        C.Ed25519KeyHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      )
      : C.StakeCredential.from_scripthash(
        C.ScriptHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      );

    this.txBuilder.add_certificate(
      C.Certificate.new_stake_registration(C.StakeRegistration.new(credential)),
      undefined,
    );
    return this;
  }

  /** Deregister a reward address. */
  deregisterStake(rewardAddress: RewardAddress, redeemer?: Redeemer): Tx {
    const addressDetails = this.lucid.utils.getAddressDetails(rewardAddress);
    if (
      addressDetails.address.type !== "Reward" ||
      !addressDetails.stakeCredential
    ) {
      throw new Error("Not a reward address provided.");
    }
    const credential = addressDetails.stakeCredential.type === "Key"
      ? C.StakeCredential.from_keyhash(
        C.Ed25519KeyHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      )
      : C.StakeCredential.from_scripthash(
        C.ScriptHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      );

    this.txBuilder.add_certificate(
      C.Certificate.new_stake_deregistration(
        C.StakeDeregistration.new(credential),
      ),
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  /** Register a stake pool. A pool deposit is required. The metadataUrl needs to be hosted already before making the registration. */
  registerPool(poolParams: PoolParams): Tx {
    this.tasks.push(async () => {
      const poolRegistration = await createPoolRegistration(
        poolParams,
        this.lucid,
      );

      const certificate = C.Certificate.new_pool_registration(
        poolRegistration,
      );

      this.txBuilder.add_certificate(certificate, undefined);
    });
    return this;
  }

  /** Update a stake pool. No pool deposit is required. The metadataUrl needs to be hosted already before making the update. */
  updatePool(poolParams: PoolParams): Tx {
    this.tasks.push(async () => {
      const poolRegistration = await createPoolRegistration(
        poolParams,
        this.lucid,
      );

      // This flag makes sure a pool deposit is not required
      poolRegistration.set_is_update(true);

      const certificate = C.Certificate.new_pool_registration(
        poolRegistration,
      );

      this.txBuilder.add_certificate(certificate, undefined);
    });
    return this;
  }
  /**
   * Retire a stake pool. The epoch needs to be the greater than the current epoch + 1 and less than current epoch + eMax.
   * The pool deposit will be sent to reward address as reward after full retirement of the pool.
   */
  retirePool(poolId: PoolId, epoch: number): Tx {
    const certificate = C.Certificate.new_pool_retirement(
      C.PoolRetirement.new(C.Ed25519KeyHash.from_bech32(poolId), epoch),
    );
    this.txBuilder.add_certificate(certificate, undefined);
    return this;
  }

  withdraw(
    rewardAddress: RewardAddress,
    amount: Lovelace,
    redeemer?: Redeemer,
  ): Tx {
    this.txBuilder.add_withdrawal(
      C.RewardAddress.from_address(C.Address.from_bech32(rewardAddress))!,
      C.BigNum.from_str(amount.toString()),
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  /**
   * Needs to be a public key address.
   * The PaymentKeyHash is taken when providing a Base, Enterprise or Pointer address.
   * The StakeKeyHash is taken when providing a Reward address.
   */
  addSigner(address: Address | RewardAddress): Tx {
    const addressDetails = this.lucid.utils.getAddressDetails(address);

    if (!addressDetails.paymentCredential && !addressDetails.stakeCredential) {
      throw new Error("Not a valid address.");
    }

    const credential = addressDetails.address.type === "Reward"
      ? addressDetails.stakeCredential!
      : addressDetails.paymentCredential!;

    if (credential.type === "Script") {
      throw new Error("Only key hashes are allowed as signers.");
    }

    return this.addSignerKey(credential.hash);
  }

  /** Add a payment or stake key hash as a required signer of the transaction. */
  addSignerKey(keyHash: PaymentKeyHash | StakeKeyHash): Tx {
    this.txBuilder.add_required_signer(
      C.Ed25519KeyHash.from_bytes(fromHex(keyHash)),
    );
    return this;
  }

  validFrom(unixTime: UnixTime): Tx {
    const slot = this.lucid.utils.unixTimeToSlot(unixTime);
    this.txBuilder.set_validity_start_interval(
      C.BigNum.from_str(slot.toString()),
    );
    return this;
  }

  validTo(unixTime: UnixTime): Tx {
    const slot = this.lucid.utils.unixTimeToSlot(unixTime);
    this.txBuilder.set_ttl(C.BigNum.from_str(slot.toString()));
    return this;
  }

  attachMetadata(label: Label, metadata: Json): Tx {
    this.txBuilder.add_json_metadatum(
      C.BigNum.from_str(label.toString()),
      JSON.stringify(metadata),
    );
    return this;
  }

  /** Converts strings to bytes if prefixed with **'0x'** */
  attachMetadataWithConversion(label: Label, metadata: Json): Tx {
    this.txBuilder.add_json_metadatum_with_schema(
      C.BigNum.from_str(label.toString()),
      JSON.stringify(metadata),
      C.MetadataJsonSchema.BasicConversions,
    );
    return this;
  }

  attachSpendingValidator(spendingValidator: SpendingValidator): Tx {
    attachScript(this, spendingValidator);
    return this;
  }

  attachMintingPolicy(mintingPolicy: MintingPolicy): Tx {
    attachScript(this, mintingPolicy);
    return this;
  }

  attachCertificateValidator(certValidator: CertificateValidator): Tx {
    attachScript(this, certValidator);
    return this;
  }

  attachWithdrawalValidator(withdrawalValidator: WithdrawalValidator): Tx {
    attachScript(this, withdrawalValidator);
    return this;
  }

  /** Conditionally add to the transaction */
  applyIf(
    condition: boolean,
    callback: (thisTx: Tx) => void | Promise<void>,
  ): Tx {
    if (condition) this.tasks.push(() => callback(this) as Promise<void>);
    return this;
  }

  async complete(options?: {
    changeAddress?: Address;
    datum?: { asHash?: Datum; inline?: Datum };
    coinSelection?: boolean;
  }): Promise<TxComplete> {
    if (options?.datum?.asHash && options?.datum?.inline) {
      throw new Error("Not allowed to set asHash and inline at the same time.");
    }

    for (const task of this.tasks) {
      await task();
    }

    const utxos = await this.lucid.wallet.getUtxosCore();

    const changeAddress: Core.Address = C.Address.from_bech32(
      options?.changeAddress || (await this.lucid.wallet.address()),
    );

    if (options?.coinSelection || options?.coinSelection === undefined) {
      this.txBuilder.add_inputs_from(utxos, changeAddress);
    }

    this.txBuilder.balance(
      changeAddress,
      options?.datum?.asHash
        ? C.Datum.new_data_hash(
          C.hash_plutus_data(
            C.PlutusData.from_bytes(fromHex(options.datum.asHash)),
          ),
        )
        : options?.datum?.inline
        ? C.Datum.new_data(
          C.Data.new(C.PlutusData.from_bytes(fromHex(options.datum.inline))),
        )
        : undefined,
    );
    if (options?.datum?.asHash) {
      this.txBuilder.add_plutus_data(
        C.PlutusData.from_bytes(fromHex(options.datum.asHash)),
      );
    }

    return new TxComplete(
      this.lucid,
      await this.txBuilder.construct(utxos, changeAddress),
    );
  }
}

function attachScript(
  tx: Tx,
  script:
    | SpendingValidator
    | MintingPolicy
    | CertificateValidator
    | WithdrawalValidator,
) {
  if (script.type === "Native") {
    return tx.txBuilder.add_native_script(
      C.NativeScript.from_bytes(fromHex(script.script)),
    );
  } else if (script.type === "PlutusV1") {
    return tx.txBuilder.add_plutus_script(
      C.PlutusScript.from_bytes(fromHex(script.script)),
    );
  } else if (script.type === "PlutusV2") {
    return tx.txBuilder.add_plutus_v2_script(
      C.PlutusScript.from_bytes(fromHex(script.script)),
    );
  }
  throw new Error("No variant matched.");
}

async function createPoolRegistration(
  poolParams: PoolParams,
  lucid: Lucid,
): Promise<Core.PoolRegistration> {
  const poolOwners = C.Ed25519KeyHashes.new();
  poolParams.owners.forEach((owner) => {
    const { stakeCredential } = lucid.utils.getAddressDetails(owner);
    if (stakeCredential?.type === "Key") {
      poolOwners.add(C.Ed25519KeyHash.from_hex(stakeCredential.hash));
    } else throw new Error("Only key hashes allowed for pool owners.");
  });

  const metadata = poolParams.metadataUrl
    ? await fetch(
      poolParams.metadataUrl,
    )
      .then((res) => res.arrayBuffer())
    : null;

  const metadataHash = metadata
    ? C.PoolMetadataHash.from_bytes(
      C.hash_blake2b256(new Uint8Array(metadata)),
    )
    : null;

  const relays = C.Relays.new();
  poolParams.relays.forEach((relay) => {
    switch (relay.type) {
      case "SingleHostIp": {
        const ipV4 = relay.ipV4
          ? C.Ipv4.new(
            new Uint8Array(relay.ipV4.split(".").map((b) => parseInt(b))),
          )
          : undefined;
        const ipV6 = relay.ipV6
          ? C.Ipv6.new(fromHex(relay.ipV6.replaceAll(":", "")))
          : undefined;
        relays.add(
          C.Relay.new_single_host_addr(
            C.SingleHostAddr.new(relay.port, ipV4, ipV6),
          ),
        );
        break;
      }
      case "SingleHostDomainName": {
        relays.add(
          C.Relay.new_single_host_name(
            C.SingleHostName.new(
              relay.port,
              C.DNSRecordAorAAAA.new(relay.domainName!),
            ),
          ),
        );
        break;
      }
      case "MultiHost": {
        relays.add(
          C.Relay.new_multi_host_name(
            C.MultiHostName.new(C.DNSRecordSRV.new(relay.domainName!)),
          ),
        );
        break;
      }
    }
  });

  return C.PoolRegistration.new(
    C.PoolParams.new(
      C.Ed25519KeyHash.from_bech32(poolParams.poolId),
      C.VRFKeyHash.from_hex(poolParams.vrfKeyHash),
      C.BigNum.from_str(poolParams.pledge.toString()),
      C.BigNum.from_str(poolParams.cost.toString()),
      C.UnitInterval.from_float(poolParams.margin),
      C.RewardAddress.from_address(
        C.Address.from_bech32(poolParams.rewardAddress),
      )!,
      poolOwners,
      relays,
      metadataHash
        ? C.PoolMetadata.new(
          C.URL.new(poolParams.metadataUrl!),
          metadataHash,
        )
        : undefined,
    ),
  );
}
