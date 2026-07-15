package com.example.services;

import com.example.models.Order;

// Mirrors EngramGraph's XSPEC-333 R3 C# SCIP PoC fixture
// (test/fixtures/scip-poc/Services/OrderService.cs): OrderService and
// UserService each define a same-named "validate" method, and the only call
// sites for both are in a THIRD file (Program.java) that defines neither
// class -- tree-sitter's cross-file bare-name resolver drops both calls as
// ambiguous (documented in docs/CROSS-FILE-COVERAGE.md's Java finding:
// 19.7% coverage on google/gson, dominated by exactly this same-name-in-
// different-classes ambiguity).
public class OrderService {
    // Same-file call: process -> validate resolves via the same-file map
    // (lexical shadowing wins over the ambiguous global name), so tree-sitter
    // already gets this one right -- this is the "upgrade an existing edge"
    // case, not a "fill a gap" case.
    public void process(Order order) {
        if (validate(order)) {
            order.setTotal(order.getTotal() + 1);
        }
    }

    public boolean validate(Order order) {
        return order.getId() > 0;
    }
}
