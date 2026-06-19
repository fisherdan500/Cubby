import { PrismaClient, HouseholdRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "owner@example.com" },
    update: {},
    create: {
      email: "owner@example.com",
      name: "Cubby Owner",
      emailVerified: true
    }
  });

  const household = await prisma.household.create({
    data: {
      name: "Demo Family",
      createdByUserId: user.id,
      members: {
        create: {
          userId: user.id,
          role: HouseholdRole.owner,
          displayName: "Owner"
        }
      },
      babies: {
        create: {
          name: "Demo Baby",
          timezone: "America/New_York"
        }
      }
    }
  });

  console.log(`Seeded ${household.name}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
