package com.example;

import com.example.models.Order;
import com.example.models.User;
import com.example.services.Calculator;
import com.example.services.NotificationService;
import com.example.services.OrderService;
import com.example.services.UserService;

public class Program {
    public static void main(String[] args) {
        Order order = new Order();
        order.setId(1);
        order.setTotal(10);

        User user = new User();
        user.setName("Ada");

        OrderService orderService = new OrderService();
        UserService userService = new UserService();
        NotificationService notificationService = new NotificationService();

        // Ambiguous case (mirrors R4/the C# PoC): both OrderService and
        // UserService define "validate". This call site is in a THIRD file
        // (Program.java), which defines neither class's validate, so
        // tree-sitter's cross-file resolver finds two global candidates for
        // the bare name "validate" and drops the call as ambiguous
        // (precision over recall) instead of guessing. A real compiler
        // (javac, via scip-java) knows orderService's static type is
        // OrderService and resolves this correctly to
        // OrderService.validate.
        if (orderService.validate(order)) {
            orderService.process(order);
        }

        // Same ambiguous shape, resolves to UserService.validate under real
        // typing.
        if (userService.validate(user)) {
            userService.register(user);
        }

        // Control case: unambiguous cross-file call (only one "notify").
        notificationService.notify("done");

        // Overload case: Calculator.add(int,int) and
        // Calculator.add(double,double) both live in ONE class --
        // tree-sitter's bare-name resolution finds exactly one *name*
        // globally ("add") and resolves it (no ambiguity from tree-sitter's
        // point of view), but the two overloads collapse onto the same
        // Function node id regardless.
        Calculator calculator = new Calculator();
        int intSum = calculator.add(1, 2);
        double doubleSum = calculator.add(1.5, 2.5);
        notificationService.notify(intSum + "/" + doubleSum);
    }
}
