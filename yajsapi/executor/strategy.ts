import { Activity } from "../props";
import { DemandBuilder } from "../props";
import { BillingScheme, ComLinear, Counter, PriceModel, PRICE_MODEL } from "../props/com";
import { OfferProposal } from "../rest/market";
import { applyMixins, logger } from "../utils";

export const SCORE_NEUTRAL = 0.0;
export const SCORE_REJECTED = -1.0;
export const SCORE_TRUSTED = 100.0;

export interface ComputationHistory {
  rejected_last_agreement: (string) => boolean;
}

export abstract class MarketStrategy {
  abstract decorate_demand(demand: DemandBuilder): Promise<void>;
  abstract score_offer(offer: OfferProposal, history?: ComputationHistory): Promise<number>;
}

class MarketGeneral {}

applyMixins(MarketGeneral, [MarketStrategy, Object]);

export class DummyMS extends MarketGeneral {
  max_for_counter: Map<Counter, number> = new Map([
    [Counter.TIME, parseFloat("0.002")],
    [Counter.CPU, parseFloat("0.002") * 10],
  ]);
  max_fixed: number = parseFloat("0.05");
  _activity?: Activity;

  async decorate_demand(demand: DemandBuilder): Promise<void> {
    demand.ensure(`(${PRICE_MODEL}=${PriceModel.LINEAR})`);
    this._activity = new Activity().from_properties(demand._properties);
  }

  async score_offer(offer: OfferProposal): Promise<number> {
    const linear: ComLinear = new ComLinear().from_properties(offer.props());

    if (linear.scheme.value !== BillingScheme.PAYU) {
      return SCORE_REJECTED;
    }

    if (linear.fixed_price > this.max_fixed) return SCORE_REJECTED;

    for (const [counter, price] of Object.entries(linear.price_for)) {
      if (!this.max_for_counter.has(counter as Counter)) return SCORE_REJECTED;
      if (price > (this.max_for_counter.get(counter as Counter) ?? 0)) return SCORE_REJECTED;
    }

    return SCORE_NEUTRAL;
  }
}

export class LeastExpensiveLinearPayuMS {
  private _expected_time_secs: number;
  private _max_fixed_price?: number;
  private _max_price_for?: Map<Counter, number>;

  constructor(expected_time_secs = 60, max_fixed_price?: number, max_price_for?: Map<Counter, number>) {
    this._expected_time_secs = expected_time_secs;
    if (max_fixed_price) this._max_fixed_price = max_fixed_price;
    if (max_price_for) this._max_price_for = max_price_for;
  }

  async decorate_demand(demand: DemandBuilder): Promise<void> {
    demand.ensure(`(${PRICE_MODEL}=${PriceModel.LINEAR})`);
  }

  async score_offer(offer: OfferProposal): Promise<number> {
    const linear: ComLinear = new ComLinear().from_properties(offer.props());

    logger.debug(`Scoring offer ${offer.id()}, parameters: ${JSON.stringify(linear)}`);
    if (linear.scheme.value !== BillingScheme.PAYU) {
      logger.debug(`Rejected offer ${offer.id()}: unsupported scheme '${linear.scheme.value}'`);
      return SCORE_REJECTED;
    }

    const known_time_prices = new Set([Counter.TIME, Counter.CPU]);

    for (const counter in linear.price_for) {
      if (!known_time_prices.has(counter as Counter)) {
        logger.debug(`Rejected offer ${offer.id()}: unsupported counter '${counter}'`);
        return SCORE_REJECTED;
      }
    }

    if (this._max_fixed_price !== undefined) {
      const fixed_price_cap = this._max_fixed_price;
      if (linear.fixed_price > fixed_price_cap) {
        logger.debug(`Rejected offer ${offer.id()}: fixed price higher than fixed price cap ${fixed_price_cap}.`);
        return SCORE_REJECTED;
      }
    }
    if (linear.fixed_price < 0) {
      logger.debug(`Rejected offer ${offer.id()}: negative fixed price`);
      return SCORE_REJECTED;
    }
    let expected_price = linear.fixed_price;

    for (const resource of known_time_prices) {
      if (linear.price_for[resource] < 0) {
        logger.debug(`Rejected offer ${offer.id()}: negative price for '${resource}'`);
        return SCORE_REJECTED;
      }
      if (this._max_price_for) {
        const max_price = this._max_price_for.get(resource as Counter);
        if (max_price !== undefined && linear.price_for[resource] > max_price) {
          logger.debug(`Rejected offer ${offer.id()}: price for '${resource}' higher than price cap ${max_price}`);
          return SCORE_REJECTED;
        }
      }
      expected_price += linear.price_for[resource] * this._expected_time_secs;
    }

    // The higher the expected price value, the lower the score.
    // The score is always lower than SCORE_TRUSTED and is always higher than 0.
    const score: number = SCORE_TRUSTED / (expected_price + 1.01);
    return score;
  }
}

export class DecreaseScoreForUnconfirmedAgreement {
  /* A market strategy that modifies a base strategy based on history of agreements. */

  private _base_strategy;
  private _factor;

  constructor(base_strategy, factor) {
    this._base_strategy = base_strategy;
    this._factor = factor;
  }

  async decorate_demand(demand: DemandBuilder): Promise<void> {
    /* Decorate `demand` using the base strategy. */
    await this._base_strategy.decorate_demand(demand);
  }

  async score_offer(offer: OfferProposal, history?: ComputationHistory): Promise<number> {
    /* Score `offer` using the base strategy and apply penalty if needed.
       If the offer issuer failed to approve the previous agreement (if any)
       then the base score is multiplied by `this._factor`. */
    let score = await this._base_strategy.score_offer(offer);
    if (history && history.rejected_last_agreement(offer.issuer()) && score > 0) {
      score *= this._factor;
      logger.debug(`Decreasing score for offer ${offer.id()} from '${offer.issuer()}'`);
    }
    return score;
  }
}
