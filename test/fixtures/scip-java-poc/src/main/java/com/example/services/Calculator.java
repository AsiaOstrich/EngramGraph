package com.example.services;

// Genuine Java method overloading (same class, same name, different
// parameter list) -- distinct from the OrderService/UserService
// "different classes, same method name" ambiguous case above. Used to check
// whether the SCIP-side id-normalization reproduces tree-sitter's own
// overload collapse (both overloads land on one Function node id,
// `.../Calculator.java#Calculator.add`).
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }

    public double add(double a, double b) {
        return a + b;
    }
}
