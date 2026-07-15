package com.example.services;

import com.example.models.User;

public class UserService {
    public void register(User user) {
        if (validate(user)) {
            user.setName(user.getName().trim());
        }
    }

    public boolean validate(User user) {
        return !user.getName().trim().isEmpty();
    }
}
