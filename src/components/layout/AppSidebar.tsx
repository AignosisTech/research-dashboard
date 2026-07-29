import { Link, useLocation, useNavigate } from 'react-router';

import { LayoutDashboard, LogOut, Tent } from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useAuth } from '@/hooks/useAuth';

const navigation = [
  {
    name: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    name: 'Camp Mode',
    href: '/camps',
    icon: Tent,
  },
];

export const AppSidebar = () => {
  const location = useLocation();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex justify-center items-center px-3 h-10">
          <div className="inline-block relative">
            <div className="absolute inset-0 h-7 from-blue-500 to-purple-500 rounded-lg opacity-60 blur-lg bg-linear-to-r"></div>
            <h1 className="relative font-montserrat z-10 text-xl font-semibold tracking-[0.5px] text-sidebar-foreground dark:text-white">
              Aignosis Research
            </h1>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2 py-4">
        <SidebarMenu className="space-y-0.5">
          {navigation.map(item => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.href || location.pathname.startsWith(`${item.href}/`);
            return (
              <SidebarMenuItem key={item.name}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  tooltip={item.name}
                  className="rounded-md transition-colors duration-150 h-9 px-2.5"
                >
                  <Link to={item.href} className="gap-2.5">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="font-medium text-[13px]">{item.name}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="p-3 border-t border-sidebar-border">
        <SidebarMenuButton
          onClick={handleLogout}
          className="rounded-md transition-colors duration-150 h-9 px-2.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          <span className="font-medium text-[13px]">Log out</span>
        </SidebarMenuButton>
      </SidebarFooter>
    </Sidebar>
  );
};
