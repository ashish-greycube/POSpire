/**
 * buildPrintContext() total math — separate from helper parity
 * (print-helper-parity.test.ts), which covers the Jinja/nunjucks helpers
 * themselves. This file covers a business-logic bug the PR review caught:
 * delivery charges were left out of the recomputed offline total.
 *
 * Invoice.vue adds the delivery charge on top of the tax result at
 * checkout (grand = offlineTax.grand_total + delivery) — untaxed, outside
 * the taxable base. buildPrintContext's recomputed branches (taxConfig
 * available, or not) must add it back the same way, or an offline
 * receipt's total (and therefore change_amount) is short by exactly the
 * delivery charge.
 */
import { describe, it, expect } from "vitest";
import { buildPrintContext } from "@/offline/print/context";

const TAX_CONFIG = {
	sales_taxes_and_charges: [
		{ account_head: "GST - TC", charge_type: "On Net Total", rate: 18, description: "GST" },
	],
	item_tax_templates: {},
};

function invoiceWith(overrides = {}) {
	return {
		name: "OFFLINE-INV-test",
		items: [{ item_code: "ITEM-1", item_name: "Item 1", qty: 1, rate: 1000, amount: 1000 }],
		taxes: [],
		payments: [],
		...overrides,
	};
}

describe("buildPrintContext — delivery charge in recomputed totals", () => {
	it("adds the delivery charge on top of the recomputed tax result (taxConfig branch)", () => {
		const invoice = invoiceWith({ posa_delivery_charges_rate: 50 });
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		// net 1000, exclusive 18% tax = 180, delivery 50 on top, untaxed.
		expect(doc.net_total).toBe(1000);
		expect(doc.total_taxes_and_charges).toBe(180);
		expect(doc.grand_total).toBe(1230);
		expect(doc.rounded_total).toBe(1230);
	});

	it("reads custom_delivery_charge_rate as a fallback for posa_delivery_charges_rate", () => {
		const invoice = invoiceWith({ custom_delivery_charge_rate: 25 });
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.grand_total).toBe(1000 + 180 + 25);
	});

	it("adds the delivery charge in the no-taxConfig fallback too", () => {
		const invoice = invoiceWith({ posa_delivery_charges_rate: 50 });
		const doc = buildPrintContext(invoice, { taxConfig: null, printConfig: {} });

		// No tax config available at all — untaxed subtotal (1000) plus the
		// delivery charge (50), not just the bare subtotal.
		expect(doc.grand_total).toBe(1000);
		expect(doc.rounded_total).toBe(1050);
	});

	it("without a delivery charge, totals are unaffected (control case)", () => {
		const invoice = invoiceWith();
		const doc = buildPrintContext(invoice, { taxConfig: TAX_CONFIG, printConfig: {} });

		expect(doc.grand_total).toBe(1180);
		expect(doc.rounded_total).toBe(1180);
	});
});
