workspace "Shop" "Shop app that suggests the next product" {

    !identifiers hierarchical

    properties {
        "code.tests" "ios/ShopTests/** ios/ShopUITests/**"
        "structurizr.inspection.model.relationship.technology" "ignore"
        "structurizr.inspection.model.softwaresystem.documentation" "ignore"
        "structurizr.inspection.model.softwaresystem.decisions" "ignore"
        "code.ignore" "design/** architecture/** AGENTS.md .gitignore"
    }

    model {
        shopper = person "Shopper" "Browses and buys products"

        marketApp = softwareSystem "Market" "Another shop; source of exported order history" {
            tags "External"
        }
        cloud = softwareSystem "Cloud" "Cloud sync and the suggestion event store" {
            tags "External"
        }
        marketCsvParser = softwareSystem "MarketCsvParser" "Swift package that parses Market's CSV export; separate repo" {
            tags "External"
        }

        shop = softwareSystem "Shop" "Sells products and suggests the next one" {
            ios = container "iOS app" "Shows products, suggests the next one" "SwiftUI, Core Data" {
                shell = component "App shell" "App lifecycle, background tasks, Core Data stack and schema, routing to the cart" "SwiftUI, Core Data" {
                    properties {
                        "code.globs" "ios/Shop-Info.plist ios/Shop/*.swift ios/Shop/*.entitlements ios/Shop/PrivacyInfo.xcprivacy ios/Shop/Base.lproj/** ios/Shop/Shop.xcdatamodeld/** ios/Shop/Assets.xcassets/** ios/Shop.xcodeproj/**"
                    }
                }
                designSystem = component "Design system" "Colours, type, fonts and shared controls such as the product row" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/DesignSystem/** ios/Shop/Resources/Fonts/**"
                    }
                }
                cart = component "Cart" "The order in progress: tab root, checkout timer, new-item page" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/Cart/**"
                    }
                }
                item = component "Item" "Shows the options of one item" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/Item/** ios/Shop/Features/Review/**"
                    }
                }
                countdown = component "Countdown" "Counts down to the end of a sale" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/Countdown/**"
                    }
                }
                priceCalculator = component "Price calculator" "Works out the price for a quantity" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/PriceCalculator/**"
                    }
                }
                productPicker = component "Product picker" "Chooses a product and its variant" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/ProductPicker/**"
                    }
                }
                orders = component "Orders" "Past orders" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/Orders/**"
                    }
                }
                onboarding = component "Onboarding" "Picks a starting catalog; tips" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Features/Onboarding/** ios/Shop/Resources/CatalogPresets.swift"
                    }
                }
                settings = component "Settings" "Preferences, currency, the product library" "SwiftUI" {
                    properties {
                        "code.globs" "ios/Shop/Settings/**"
                    }
                }
                marketImport = component "Market import" "Turns a Market CSV into orders" "Swift" {
                    properties {
                        "code.globs" "ios/Shop/Features/Import/**"
                    }
                }
                data = component "Data" "Repositories over Core Data: products, items, carts, catalogs, orders" "Swift, Core Data" {
                    properties {
                        "code.globs" "ios/Shop/Repositories/*Repository.swift ios/Shop/Repositories/OrderService.swift ios/Shop/Repositories/Product{Variant,Migration,Rating}.swift ios/Shop/Repositories/CartContext.swift ios/Shop/Resources/ProductMetadata.swift"
                    }
                }
                suggestions = component "Suggestions" "Predicts the next product: Core ML model, habit learning, on-device personalisation" "Swift, Core ML" {
                    properties {
                        "code.globs" "ios/Shop/Repositories/{CoreMLPredictor,NextProductSuggester,OnDevicePersonalizer,PersonalizationScheduler,PredictionContext,HabitLearner,SuggestionTrace}.swift ios/Shop/Resources/NextProduct.mlmodel"
                    }
                }
                suggestionTelemetry = component "Suggestion telemetry" "Logs which suggestions were taken and syncs them to the cloud" "Swift, Cloud" {
                    properties {
                        "code.globs" "ios/Shop/Repositories/{SuggestionEventLogger,SuggestionEventSync,CloudSuggestionEventPublisher}.swift"
                    }
                }
            }

            site = container "Landing site" "Marketing page" "Static HTML" {
                properties {
                    "code.globs" "site/**"
                }
            }

            exportTool = container "Export tool" "Exports order history to CSV for Create ML; nothing ships" "Swift CLI" {
                properties {
                    "code.globs" "tools/**"
                }
            }
        }

        shopper -> shop.ios "Shops with"
        shopper -> marketApp "Exports orders from"
        shopper -> shop.site "Finds the app through"
        shop.ios -> cloud "Syncs data and suggestion events to"

        shop.ios.shell -> shop.ios.cart "Routes to"
        shop.ios.shell -> shop.ios.onboarding "Shows on first launch"
        shop.ios.shell -> shop.ios.suggestions "Schedules personalisation for"
        shop.ios.shell -> shop.ios.suggestionTelemetry "Schedules sync for"
        shop.ios.shell -> cloud "Syncs Core Data through"

        shop.ios.cart -> shop.ios.item "Opens; passes it the countdown"
        shop.ios.cart -> shop.ios.countdown "Owns; plays the finish sound"
        shop.ios.cart -> shop.ios.productPicker "Opens"
        shop.ios.cart -> shop.ios.orders "Opens"
        shop.ios.cart -> shop.ios.settings "Opens"
        shop.ios.cart -> shop.ios.suggestions "Asks for the next product"
        shop.ios.cart -> shop.ios.suggestionTelemetry "Logs suggestion outcomes to"
        shop.ios.cart -> shop.ios.data "Reads and writes"

        shop.ios.item -> shop.ios.countdown "Shows"
        shop.ios.item -> shop.ios.priceCalculator "Opens"
        shop.ios.item -> shop.ios.productPicker "Opens"
        shop.ios.item -> shop.ios.suggestions "Asks for the next product"
        shop.ios.item -> shop.ios.data "Reads and writes"

        shop.ios.cart -> shop.ios.designSystem "Draws with"
        shop.ios.item -> shop.ios.designSystem "Draws with"

        shop.ios.productPicker -> shop.ios.data "Reads"
        shop.ios.orders -> shop.ios.data "Reads"
        shop.ios.onboarding -> shop.ios.data "Creates a catalog in"
        shop.ios.settings -> shop.ios.marketImport "Hands the parsed export to"
        shop.ios.settings -> marketCsvParser "Parses the CSV with"
        shop.ios.settings -> shop.ios.data "Reads and writes"

        shop.ios.marketImport -> marketCsvParser "Converts its parsed export"
        shop.ios.marketImport -> shop.ios.data "Writes orders to"

        shop.ios.suggestions -> shop.ios.data "Reads orders from"
        shop.ios.suggestionTelemetry -> cloud "Publishes events to"

        shop.exportTool -> marketApp "Reads CSV exported from"
    }

    configuration {
        scope softwaresystem
    }

    views {
        systemContext shop "Context" {
            include *
            autoLayout lr
        }
        container shop "Containers" {
            include *
            autoLayout lr
        }
        component shop.ios "Components" {
            include *
            autoLayout lr
        }

        styles {
            element "Person" {
                shape person
            }
            element "External" {
                background #999999
                color #ffffff
            }
        }
    }
}
