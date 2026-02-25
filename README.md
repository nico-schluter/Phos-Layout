# Phos-Layout
Design prototype for an interactive PCB component placement tool:

[Try it out!](https://nico-schluter.github.io/Phos-Layout/)
<img width="1343" height="718" alt="image" src="https://github.com/user-attachments/assets/aa9a1978-06b3-4316-bc9a-d4ee730578eb" />

## Useage
`shift + LMB` Force simulation brush
`shift + LMB + RMB` Force simulation brush with higher entropy
`alt + LMB` Rotational alignment brush
`alt + RMB` Grid alisngment brush

## Experiments

### Force simulation
The main question of this experiment is if a force simulation, like commonly used for visualizing node graphs, will result in a good or at least useable component plasement.

Issue encountered are:
- No consideration of net crossings
- Does not understand design intent
- preferrs iso grid to a linear layout

Conclusion:
Node force sumulations only have very limited use for PCB component placement

### Alignment brush
A simple tool for aligning components, both rotiationally as well as to a grid

Conclusion:
This tool is extremely useful, as it allows for two staged placement, first a rough movem, then a grid align.
Brush alignment tool seems much more pleasant that grid snapping while moving, and removes stree from getting placements right right away.

### Voronoi based copper island generation
Does simply creating a vorenoi map of the points, and then isolation routhing the edges between two net islands create a simple autorouting?

Issue encountered:
- Edges are unnecessarily jagged.
- There is no guarantt that two cells of the same net are connected (for example if another net is in the middle

Conclusion:
This in not a viable approach for generating copper islands from a placement

