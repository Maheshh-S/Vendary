"use client";
import { Session } from "next-auth";
import React from "react";
import { Dropdown, DropdownButton, DropdownItem, DropdownMenu } from "@/components/ui/dropdown";
import { ChevronDownIcon } from "@heroicons/react/16/solid";
import Image from "next/image";
import { signOut } from "next-auth/react";

type Props = {
  session: Session | null;
};
//TODO: make it functinonal
const UserButton = ({ session }: Props) => {
  return (
    <Dropdown>
      <DropdownButton outline>
        <Image
          src={session?.user?.image || "/default-profile-pic.png"}
          alt="User Avatar"
          width={32}
          height={32}
          className="rounded-full"
          priority
        />
        {session?.user?.name ? (
          <span
            data-testid="header-user-name"
            className="hidden max-w-40 truncate text-sm font-medium md:inline"
          >
            {session.user.name}
          </span>
        ) : null}
        <ChevronDownIcon />
      </DropdownButton>
      <DropdownMenu>
        <DropdownItem href="/account">
          <span>Account settings</span>
        </DropdownItem>
        <DropdownItem href="/account/addresses">
          <span>Saved addresses</span>
        </DropdownItem>
        <DropdownItem href="/my-orders">
          <span>My Orders</span>
        </DropdownItem>
        <DropdownItem
          onClick={() => {
            signOut({ callbackUrl: "/" });
          }}
        >
          <span>Log out</span>
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
};

export default UserButton;
